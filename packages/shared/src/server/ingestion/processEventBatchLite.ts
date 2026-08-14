/**
 * Lite-mode event batch processing.
 *
 * Bypasses S3 + Redis entirely. Validates events using the same schema as
 * full mode, then writes directly to SQLite via the TelemetryDBAdapter.
 */

import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { UnauthorizedError } from "../../errors";
import { getTelemetryDB } from "../adapters";
import {
  TRACE_METRICS_CACHE_CREATION_TOKENS_SQL,
  TRACE_METRICS_CACHED_TOKENS_SQL,
  TRACE_METRICS_GROSS_INPUT_TOKENS_SQL,
} from "../adapters/sqlite-telemetry-adapter";
import type { AuthHeaderValidVerificationResultIngestion } from "../auth/types";
import { getClickhouseEntityType } from "../clickhouse/schemaUtils";
import { logger } from "../logger";
import type { IngestionAttribution } from "./ingestionAttribution";
import { createIngestionEventSchema, eventTypes } from "./types";

type ProcessEventBatchLiteOptions = {
  isLangfuseInternal?: boolean;
  attribution: IngestionAttribution;
};

/**
 * Serialize a value for SQLite storage.
 */
function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace("Z", "");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/**
 * Derive the observation `type` (GENERATION, AGENT, TOOL, ...) from the
 * ingestion event type. Mirrors the full-mode `getObservationType` in the
 * worker's IngestionService. The type is encoded in the event type string
 * (e.g. "agent-create" → "AGENT"), NOT in `body.type` — only the legacy
 * observation-create/update events carry an explicit `body.type`.
 */
function getObservationTypeFromEventType(eventType: string, body: Record<string, unknown>): string {
  switch (eventType) {
    case eventTypes.OBSERVATION_CREATE:
    case eventTypes.OBSERVATION_UPDATE:
      return ((body.type as string) ?? "SPAN").toUpperCase();
    case eventTypes.EVENT_CREATE:
      return "EVENT";
    case eventTypes.SPAN_CREATE:
    case eventTypes.SPAN_UPDATE:
      return "SPAN";
    case eventTypes.GENERATION_CREATE:
    case eventTypes.GENERATION_UPDATE:
      return "GENERATION";
    case eventTypes.AGENT_CREATE:
      return "AGENT";
    case eventTypes.TOOL_CREATE:
      return "TOOL";
    case eventTypes.CHAIN_CREATE:
      return "CHAIN";
    case eventTypes.RETRIEVER_CREATE:
      return "RETRIEVER";
    case eventTypes.EVALUATOR_CREATE:
      return "EVALUATOR";
    case eventTypes.EMBEDDING_CREATE:
      return "EMBEDDING";
    case eventTypes.GUARDRAIL_CREATE:
      return "GUARDRAIL";
    default:
      return ((body.type as string) ?? "SPAN").toUpperCase();
  }
}

/**
 * Convert an ingestion event body to a SQLite row for the given table.
 */
function eventToRow(
  event: z.infer<ReturnType<typeof createIngestionEventSchema>>,
  projectId: string,
): { table: string; row: Record<string, unknown> } | null {
  const entityType = getClickhouseEntityType(event.type);
  const body = event.body as Record<string, unknown>;
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");

  const baseRow: Record<string, unknown> = {
    id: body.id,
    project_id: projectId,
    created_at: now,
    updated_at: now,
    event_ts: event.timestamp
      ? new Date(event.timestamp as string).toISOString().replace("T", " ").replace("Z", "")
      : now,
    is_deleted: 0,
  };

  if (entityType === "trace") {
    return {
      table: "traces",
      row: {
        ...baseRow,
        timestamp: body.timestamp
          ? new Date(body.timestamp as string).toISOString().replace("T", " ").replace("Z", "")
          : now,
        name: body.name ?? null,
        user_id: body.userId ?? null,
        metadata: serializeValue(body.metadata) ?? "{}",
        release: body.release ?? null,
        version: body.version ?? null,
        public: body.public ? 1 : 0,
        bookmarked: 0,
        tags: serializeValue(body.tags) ?? "[]",
        input: serializeValue(body.input) ?? null,
        output: serializeValue(body.output) ?? null,
        session_id: body.sessionId ?? null,
        environment: (body.environment as string) ?? "default",
      },
    };
  }

  if (entityType === "observation") {
    return {
      table: "observations",
      row: {
        ...baseRow,
        trace_id: body.traceId ?? null,
        parent_observation_id: body.parentObservationId ?? null,
        type: getObservationTypeFromEventType(event.type, body),
        name: body.name ?? null,
        start_time: body.startTime
          ? new Date(body.startTime as string).toISOString().replace("T", " ").replace("Z", "")
          : now,
        end_time: body.endTime
          ? new Date(body.endTime as string).toISOString().replace("T", " ").replace("Z", "")
          : null,
        metadata: serializeValue(body.metadata) ?? "{}",
        model: body.model ?? null,
        input: serializeValue(body.input) ?? null,
        output: serializeValue(body.output) ?? null,
        level: (body.level as string) ?? "DEFAULT",
        status_message: body.statusMessage ?? null,
        completion_start_time: body.completionStartTime
          ? new Date(body.completionStartTime as string)
              .toISOString()
              .replace("T", " ")
              .replace("Z", "")
          : null,
        model_parameters: serializeValue(body.modelParameters) ?? "{}",
        usage_details: serializeValue(body.usage ?? body.usageDetails) ?? "{}",
        cost_details: serializeValue(body.costDetails) ?? "{}",
        provided_usage_details: serializeValue(body.usage ?? body.usageDetails) ?? "{}",
        provided_cost_details: serializeValue(body.costDetails) ?? "{}",
        total_cost: body.totalCost ?? null,
        version: body.version ?? null,
        environment: (body.environment as string) ?? "default",
      },
    };
  }

  if (entityType === "score") {
    const dataType = (body.dataType as string) ?? "NUMERIC";
    // Lite adaptation of the upstream inflateScoreBody (validateAndInflateScore):
    // the SDK only sends `value` + `dataType` (no stringValue), while the
    // scores table — and the v1 GET /scores response schema — expect a numeric
    // `value` plus a `string_value` for CATEGORICAL/BOOLEAN/TEXT. Without this
    // derivation those scores fail the public-API validation and silently
    // disappear from GET /api/public/scores.
    let value = body.value ?? null;
    let stringValue = body.stringValue ?? null;
    if (dataType === "CATEGORICAL" || dataType === "TEXT") {
      stringValue = typeof body.value === "string" ? body.value : stringValue;
      // Upstream inflateScoreBody stores a numeric placeholder (config-mapped
      // value for CATEGORICAL, 0 for TEXT) in `value`; the text lives in
      // `string_value`. A raw string in `value` becomes NaN on read and the
      // score is dropped by the public-API validation.
      value = 0;
    } else if (dataType === "BOOLEAN") {
      stringValue = body.value === 1 ? "True" : "False";
    }
    return {
      table: "scores",
      row: {
        ...baseRow,
        // Upstream semantics: the server generates the id when absent (the
        // SDK's score events carry the id only on the event envelope, never
        // in the body).
        id: body.id ?? randomUUID(),
        trace_id: body.traceId ?? null,
        observation_id: body.observationId ?? null,
        name: body.name ?? "unknown",
        value,
        string_value: stringValue,
        source: (body.source as string) ?? "API",
        comment: body.comment ?? null,
        author_user_id: body.authorUserId ?? null,
        config_id: body.configId ?? null,
        data_type: dataType,
        timestamp: body.timestamp
          ? new Date(body.timestamp as string).toISOString().replace("T", " ").replace("Z", "")
          : now,
        environment: (body.environment as string) ?? "default",
      },
    };
  }

  if (entityType === "dataset_run_item") {
    const datasetVersion = (body.datasetVersion as string) ?? null;
    if (datasetVersion) {
      // Lite has no versioned (as-of) queries – log only (see D1/D2).
      logger.debug(
        `[processEventBatchLite] datasetVersion ${datasetVersion} ignored for dataset run item`,
      );
    }
    return {
      table: "dataset_run_items",
      row: {
        ...baseRow,
        // Upstream semantics: the server generates the id when absent.
        id: body.id ?? randomUUID(),
        dataset_run_id: body.runId,
        dataset_item_id: body.datasetItemId,
        dataset_id: body.datasetId,
        trace_id: body.traceId,
        observation_id: body.observationId ?? null,
        error: body.error ?? null,
        dataset_item_valid_from: null,
        dataset_version: datasetVersion,
      },
    };
  }

  return null;
}

export const processEventBatchLite = async (
  input: unknown[],
  authCheck: AuthHeaderValidVerificationResultIngestion,
  options: ProcessEventBatchLiteOptions,
): Promise<{
  successes: { id: string; status: number }[];
  errors: { id: string; status: number; message?: string; error?: string }[];
}> => {
  if (input.length === 0) {
    return { successes: [], errors: [] };
  }

  const { isLangfuseInternal = false } = options;

  if (!authCheck.scope.projectId) {
    throw new UnauthorizedError("Missing project ID");
  }

  const projectId = authCheck.scope.projectId;
  const ingestionSchema = createIngestionEventSchema(isLangfuseInternal);

  const successes: { id: string; status: number }[] = [];
  const errors: {
    id: string;
    status: number;
    message?: string;
    error?: string;
  }[] = [];

  // Validate and group events by table
  const rowsByTable: Record<string, Record<string, unknown>[]> = {
    traces: [],
    observations: [],
    scores: [],
    dataset_run_items: [],
  };

  for (const event of input) {
    const parsed = ingestionSchema.safeParse(event);
    if (!parsed.success) {
      errors.push({
        id:
          typeof event === "object" && event && "id" in event
            ? String((event as Record<string, unknown>).id)
            : "unknown",
        status: 400,
        message: parsed.error.message,
        error: "InvalidRequestError",
      });
      continue;
    }

    const ingestionEvent = parsed.data;

    // Skip SDK_LOG events
    if (ingestionEvent.type === eventTypes.SDK_LOG) {
      successes.push({ id: ingestionEvent.id, status: 201 });
      continue;
    }

    const result = eventToRow(ingestionEvent, projectId);
    if (result) {
      rowsByTable[result.table].push(result.row);
      successes.push({ id: ingestionEvent.id, status: 201 });
    } else {
      // Unknown entity type – still mark as success (e.g. sdk-log)
      successes.push({ id: ingestionEvent.id, status: 201 });
    }
  }

  // Merge multiple trace rows for the same traceId (OTEL generates one
  // trace-create per span that carries trace-level attributes). Later events
  // override earlier ones on a per-field basis; null/undefined never overwrites
  // a previously-set value. This mirrors ClickHouse's ReplacingMergeTree
  // coalesce semantics used in the full ingestion pipeline.
  const mergedTraces = new Map<string, Record<string, unknown>>();
  for (const row of rowsByTable.traces) {
    const id = row.id as string;
    const existing = mergedTraces.get(id);
    if (!existing) {
      mergedTraces.set(id, { ...row });
    } else {
      for (const [key, value] of Object.entries(row)) {
        if (value != null && value !== "" && value !== "[]" && value !== "{}") {
          existing[key] = value;
        }
      }
      // Always advance updated_at / event_ts to the latest event
      existing.updated_at = row.updated_at;
      existing.event_ts = row.event_ts;
    }
  }
  rowsByTable.traces = [...mergedTraces.values()];

  // Propagate input/output from observations to traces that lack them.
  // Some OTEL SDKs (e.g. peri-agent) only set IO on observation-level spans
  // (like agent-run) without setting langfuse.trace.input/output attributes.
  // This makes traces appear "half-recorded" in the UI. We fix this by
  // inheriting IO from the root observation or its nearest children.
  const hasIO = (v: unknown): boolean => v != null && v !== "" && v !== "null" && v !== '""';
  for (const trace of rowsByTable.traces) {
    if (hasIO(trace.input) && hasIO(trace.output)) continue;
    const traceObs = rowsByTable.observations.filter((o) => o.trace_id === trace.id);
    if (traceObs.length === 0) continue;
    // Prefer the root observation (no parent)
    const root = traceObs.find((o) => !o.parent_observation_id || o.parent_observation_id === "");
    if (root) {
      if (!hasIO(trace.input) && hasIO(root.input)) trace.input = root.input;
      if (!hasIO(trace.output) && hasIO(root.output)) trace.output = root.output;
    }
    // If still missing, try direct children of the root (or all obs)
    if (!hasIO(trace.input) || !hasIO(trace.output)) {
      const children = root
        ? traceObs.filter((o) => o.parent_observation_id === root.id)
        : traceObs;
      for (const child of children) {
        if (!hasIO(trace.input) && hasIO(child.input)) trace.input = child.input;
        if (!hasIO(trace.output) && hasIO(child.output)) trace.output = child.output;
        if (hasIO(trace.input) && hasIO(trace.output)) break;
      }
    }
  }

  // Write to SQLite
  const db = getTelemetryDB();
  for (const [table, rows] of Object.entries(rowsByTable)) {
    if (rows.length === 0) continue;
    try {
      if (table === "traces" && db.mergeInsert) {
        // Use merge semantics for traces: later events only overwrite
        // non-null fields, preserving name/userId/tags from earlier events.
        await db.mergeInsert({
          table: table as "traces" | "observations" | "scores" | "dataset_run_items",
          records: rows,
        });
      } else {
        await db.insert({
          table: table as "traces" | "observations" | "scores" | "dataset_run_items",
          records: rows,
        });
      }
    } catch (error) {
      logger.error(`[processEventBatchLite] Failed to insert into ${table}`, {
        error: error instanceof Error ? error.message : String(error),
        rowCount: rows.length,
      });
    }
  }

  // Update materialized trace_metrics for affected traces
  if (rowsByTable.observations.length > 0) {
    const affectedTraceIds = new Set<string>();
    for (const obs of rowsByTable.observations) {
      if (obs.trace_id) affectedTraceIds.add(String(obs.trace_id));
    }
    if (affectedTraceIds.size > 0) {
      try {
        const placeholders = [...affectedTraceIds].map((_, i) => `@tid${i}`).join(",");
        const params: Record<string, unknown> = { projectId };
        [...affectedTraceIds].forEach((id, i) => {
          params[`tid${i}`] = id;
        });
        await db.command({
          query: `
            INSERT OR REPLACE INTO trace_metrics (project_id, trace_id, user_id, session_id, obs_count, total_cost, input_cost, output_cost, input_tokens, output_tokens, total_tokens, cached_tokens, cache_creation_tokens, gross_input_tokens, timestamp)
            SELECT o.project_id, o.trace_id, t.user_id, t.session_id,
                   COUNT(*),
                   COALESCE(SUM(o.total_cost), 0),
                   COALESCE(SUM(COALESCE(json_extract(o.cost_details, '$.input'), 0)), 0),
                   COALESCE(SUM(COALESCE(json_extract(o.cost_details, '$.output'), 0)), 0),
                   COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.input'), 0)), 0),
                   COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.output'), 0)), 0),
                   COALESCE(SUM(COALESCE(json_extract(o.usage_details, '$.total'),
                       COALESCE(json_extract(o.usage_details, '$.input'), 0) +
                       COALESCE(json_extract(o.usage_details, '$.output'), 0))), 0),
                   ${TRACE_METRICS_CACHED_TOKENS_SQL},
                   ${TRACE_METRICS_CACHE_CREATION_TOKENS_SQL},
                   ${TRACE_METRICS_GROSS_INPUT_TOKENS_SQL},
                   t.timestamp
            FROM observations o
            LEFT JOIN traces t ON t.project_id = o.project_id AND t.id = o.trace_id
            WHERE o.project_id = @projectId AND o.trace_id IN (${placeholders}) AND o.is_deleted = 0
            GROUP BY o.project_id, o.trace_id
          `,
          params,
        });
      } catch (error) {
        logger.error("[processEventBatchLite] Failed to update trace_metrics", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { successes, errors };
};
