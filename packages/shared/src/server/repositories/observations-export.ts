import {
  LEGACY_OBSERVATION_EXPORT_FIELDS,
  OBSERVATION_FIELD_GROUPS_FULL,
  type ObservationFieldGroupFull,
} from "../../domain/observation-field-groups";
import { env } from "../../env";
import type { AnalyticsGenerationEvent } from "../analytics-integrations/types";
import { convertDateToClickhouseDateTime } from "../clickhouse/client";
import {
  BLOB_EXPORT_PARQUET_CLICKHOUSE_SETTINGS,
  queryClickhouseExecRaw,
  queryClickhouseStream,
  queryClickhouseStreamRawText,
} from "./clickhouse";
import { OBSERVATIONS_TO_TRACE_INTERVAL, TRACE_TO_OBSERVATIONS_INTERVAL } from "./constants";

// SQL expressions for the export fields of LEGACY_OBSERVATION_EXPORT_FIELDS
// (the domain-level export contract) that are not plain column reads. Every
// other field selects the table column of the same name.
export const LEGACY_OBSERVATION_EXPORT_SQL_OVERRIDES: Record<string, string> = {
  latency:
    "if(isNull(end_time), NULL, date_diff('millisecond', start_time, end_time) / 1000) as latency",
  time_to_first_token:
    "if(isNull(completion_start_time), NULL, date_diff('millisecond', start_time, completion_start_time) / 1000) as time_to_first_token",
  model_id: "internal_model_id as model_id",
};

// Shared SQL+params builder for the observations blob-export. Both the parsed
// stream (standard path) and the raw-passthrough path (LFE-10402) run the
// SAME query, so the output is parsed-equal by construction. Note latency is
// already converted to seconds in the SELECT (no JS conversion needed), so this
// query is identical for both paths.
export const buildObservationsForBlobStorageExportQuery = (
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
  fieldGroups: ObservationFieldGroupFull[],
) => {
  // core is always required (provides id, trace_id, start/end_time used for deduplication)
  const effectiveGroups = new Set<ObservationFieldGroupFull>(["core", ...fieldGroups]);

  const selectedColumns = LEGACY_OBSERVATION_EXPORT_FIELDS.filter((column) =>
    effectiveGroups.has(column.group),
  ).map((column) => LEGACY_OBSERVATION_EXPORT_SQL_OVERRIDES[column.field] ?? column.field);

  const query = `
    SELECT
      ${selectedColumns.join(",\n      ")}
    FROM observations
    WHERE project_id = {projectId: String}
    AND start_time >= {minTimestamp: DateTime64(3)}
    AND start_time <= {maxTimestamp: DateTime64(3)}
    ORDER BY event_ts DESC
    LIMIT 1 BY id, project_id, type
  `;

  return {
    query,
    params: {
      projectId,
      minTimestamp: convertDateToClickhouseDateTime(minTimestamp),
      maxTimestamp: convertDateToClickhouseDateTime(maxTimestamp),
    },
    // Tagged explicitly: worker baggage isn't active during the deferred stream send.
    tags: { projectId, surface: "worker", route: "blob_export" },
    clickhouseConfigs: {
      request_timeout: env.LANGFUSE_CLICKHOUSE_DATA_EXPORT_REQUEST_TIMEOUT_MS,
    },
    preferredClickhouseService: "ReadOnly" as const,
  };
};

export const getObservationsForBlobStorageExport = (
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
  fieldGroups: ObservationFieldGroupFull[] = [...OBSERVATION_FIELD_GROUPS_FULL],
) =>
  queryClickhouseStream<Record<string, unknown>>(
    buildObservationsForBlobStorageExportQuery(projectId, minTimestamp, maxTimestamp, fieldGroups),
  );

// Raw-passthrough variant (LFE-10402): yields each row's unparsed JSONEachRow
// text, skipping the per-row parse/enrich/serialize cycle. Price columns are
// NOT added here — that enrichment is dropped on this path.
export const getObservationsForBlobStorageExportRaw = (
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
  fieldGroups: ObservationFieldGroupFull[] = [...OBSERVATION_FIELD_GROUPS_FULL],
) =>
  queryClickhouseStreamRawText(
    buildObservationsForBlobStorageExportQuery(projectId, minTimestamp, maxTimestamp, fieldGroups),
  );

// LFE-10463: FORMAT Parquet export — reuses the field-group-aware builder and
// streams raw binary bytes to upload. Like raw passthrough, no JS enrichment, so
// price columns are NOT added.
export const getObservationsForBlobStorageExportParquet = (
  projectId: string,
  minTimestamp: Date,
  maxTimestamp: Date,
  fieldGroups: ObservationFieldGroupFull[] = [...OBSERVATION_FIELD_GROUPS_FULL],
) =>
  queryClickhouseExecRaw({
    ...buildObservationsForBlobStorageExportQuery(
      projectId,
      minTimestamp,
      maxTimestamp,
      fieldGroups,
    ),
    format: "Parquet",
    clickhouseSettings: BLOB_EXPORT_PARQUET_CLICKHOUSE_SETTINGS,
  });

export const getGenerationsForAnalyticsIntegrations = async function* (
  projectId: string,
  projectName: string,
  minTimestamp: Date,
  maxTimestamp: Date,
  options: { useGraceHash?: boolean } = {},
) {
  // Pre-filter traces in a CTE so the trace timestamp window prunes partitions
  // directly, instead of living alongside the LEFT JOIN where the planner
  // cannot push it down. LEFT JOIN keeps generations whose trace is missing or
  // outside the 7-day window — they still ship to PostHog with NULL trace
  // fields rather than being silently dropped.
  const query = `
    WITH selected_traces AS (
      SELECT
        t.project_id as project_id,
        t.id as id,
        t.name as name,
        t.session_id as session_id,
        t.user_id as user_id,
        t.release as release,
        t.tags as tags,
        t.metadata['$posthog_session_id'] as posthog_session_id,
        t.metadata['$mixpanel_session_id'] as mixpanel_session_id
      FROM traces t FINAL
      WHERE t.project_id = {projectId: String}
      AND t.timestamp >= {minTimestamp: DateTime64(3)} - ${OBSERVATIONS_TO_TRACE_INTERVAL}
      AND t.timestamp <= {maxTimestamp: DateTime64(3)} + ${TRACE_TO_OBSERVATIONS_INTERVAL}
    )

    SELECT
      o.name as name,
      o.start_time as start_time,
      o.id as id,
      o.total_cost as total_cost,
      if(isNull(completion_start_time), NULL, date_diff('millisecond', start_time, completion_start_time)) as time_to_first_token,
      o.usage_details['total'] as input_tokens,
      o.usage_details['output'] as output_tokens,
      o.cost_details['total'] as total_tokens,
      o.project_id as project_id,
      if(isNull(end_time), NULL, date_diff('millisecond', start_time, end_time) / 1000) as latency,
      o.provided_model_name as model,
      o.level as level,
      o.version as version,
      o.environment as environment,
      t.id as trace_id,
      t.name as trace_name,
      t.session_id as trace_session_id,
      t.user_id as trace_user_id,
      t.release as trace_release,
      t.tags as trace_tags,
      t.posthog_session_id as posthog_session_id,
      t.mixpanel_session_id as mixpanel_session_id
    FROM observations o FINAL
    LEFT JOIN selected_traces t ON o.trace_id = t.id AND o.project_id = t.project_id
    WHERE o.project_id = {projectId: String}
    AND o.start_time >= {minTimestamp: DateTime64(3)}
    AND o.start_time < {maxTimestamp: DateTime64(3)}
    AND o.type = 'GENERATION'
  `;

  const records = queryClickhouseStream<Record<string, unknown>>({
    query,
    params: {
      projectId,
      minTimestamp: convertDateToClickhouseDateTime(minTimestamp),
      maxTimestamp: convertDateToClickhouseDateTime(maxTimestamp),
    },
    // Tagged explicitly: worker baggage isn't active during the deferred stream send.
    tags: { projectId, surface: "worker", route: "analytics_integration" },
    clickhouseConfigs: {
      request_timeout: env.LANGFUSE_CLICKHOUSE_DATA_EXPORT_REQUEST_TIMEOUT_MS,
      ...(options.useGraceHash
        ? {
            clickhouse_settings: {
              join_algorithm: "grace_hash",
              grace_hash_join_initial_buckets: "32",
            },
          }
        : {}),
    },
  });

  const baseUrl = env.NEXTAUTH_URL?.replace("/api/auth", "");
  for await (const record of records) {
    yield {
      timestamp: record.start_time,
      langfuse_generation_name: record.name,
      langfuse_trace_name: record.trace_name,
      langfuse_trace_id: record.trace_id,
      langfuse_url: `${baseUrl}/project/${projectId}/traces/${encodeURIComponent(record.trace_id as string)}?observation=${encodeURIComponent(record.id as string)}`,
      langfuse_user_url: record.trace_user_id
        ? `${baseUrl}/project/${projectId}/users/${encodeURIComponent(record.trace_user_id as string)}`
        : undefined,
      langfuse_id: record.id,
      langfuse_cost_usd: record.total_cost,
      langfuse_input_units: record.input_tokens,
      langfuse_output_units: record.output_tokens,
      langfuse_total_units: record.total_tokens,
      langfuse_session_id: record.trace_session_id,
      langfuse_project_id: projectId,
      langfuse_project_name: projectName,
      langfuse_user_id: record.trace_user_id || null,
      langfuse_latency: record.latency,
      langfuse_time_to_first_token: record.time_to_first_token,
      langfuse_release: record.trace_release,
      langfuse_version: record.version,
      langfuse_model: record.model,
      langfuse_level: record.level,
      langfuse_tags: record.trace_tags,
      langfuse_environment: record.environment,
      langfuse_event_version: "1.0.0",
      posthog_session_id: record.posthog_session_id ?? null,
      mixpanel_session_id: record.mixpanel_session_id ?? null,
    } satisfies AnalyticsGenerationEvent;
  }
};
