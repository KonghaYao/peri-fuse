/**
 * Lite-mode event batch processing.
 *
 * Bypasses S3 + Redis entirely. Validates events using the same schema as
 * full mode, then writes directly to SQLite via the TelemetryDBAdapter.
 */

import type { z } from "zod";
import { UnauthorizedError } from "../../errors";
import { getTelemetryDB } from "../adapters";
import type { AuthHeaderValidVerificationResultIngestion } from "../auth/types";
import { getClickhouseEntityType } from "../clickhouse/schemaUtils";
import { logger } from "../logger";
import type { IngestionAttribution } from "./ingestionAttribution";
import { liteEntityId, liteUpdateColumns } from "./lite-patch";
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

// 正文进入 codec 前固定为 SQLite 原 TEXT；数字/布尔沿用原 TEXT affinity 结果。
function serializeIo(value: unknown): string | null {
  const serialized = serializeValue(value);
  return serialized == null ? null : String(serialized);
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
    id: body.id ?? liteEntityId(projectId, event.type, event.id),
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
        input: serializeIo(body.input),
        output: serializeIo(body.output),
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
        input: serializeIo(body.input),
        output: serializeIo(body.output),
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
    if (dataType === "CATEGORICAL" || dataType === "TEXT" || dataType === "CORRECTION") {
      stringValue = typeof body.value === "string" ? body.value : stringValue;
      // Upstream inflateScoreBody stores a numeric placeholder (config-mapped
      // value for CATEGORICAL, 0 for TEXT/CORRECTION) in `value`; the text
      // lives in `string_value`. A raw string in `value` becomes NaN on read
      // and the score is dropped by the public-API validation.
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
        id: baseRow.id,
        trace_id: body.traceId ?? null,
        observation_id: body.observationId ?? null,
        session_id: body.sessionId ?? null,
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
        metadata: serializeValue(body.metadata) ?? "{}",
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
        id: baseRow.id,
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

  const eventIds: Record<string, string[]> = {};
  const updates: Record<string, string[][]> = {};
  // 批内预排序减少无效覆盖；跨请求冲突由事务内持久化的逐字段版本解决。
  const ordered = [...input].sort((a, b) => {
    const time = (v: unknown) => {
      if (!v || typeof v !== "object" || !("timestamp" in v)) return 0;
      return Date.parse(String(v.timestamp)) || 0;
    };
    return time(a) - time(b);
  });
  for (const event of ordered) {
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
      eventIds[result.table] ??= [];
      eventIds[result.table].push(ingestionEvent.id);
      const raw = (event as { body: Record<string, unknown> }).body;
      updates[result.table] ??= [];
      updates[result.table].push(
        liteUpdateColumns(raw, ingestionEvent.body as Record<string, unknown>),
      );
    } else {
      // Unknown entity type – still mark as success (e.g. sdk-log)
      successes.push({ id: ingestionEvent.id, status: 201 });
    }
  }

  // 不再批内合并：每个 envelope 都经过相同的字段级 UPSERT 规则。

  // Propagate input/output from observations to traces that lack them.
  // Some OTEL SDKs (e.g. peri-agent) only set IO on observation-level spans
  // (like agent-run) without setting langfuse.trace.input/output attributes.
  // This makes traces appear "half-recorded" in the UI. We fix this by
  // inheriting IO from the root observation or its nearest children.
  const hasIO = (v: unknown): boolean => v != null;
  const inherited = rowsByTable.traces.map(() => [] as string[]);
  for (const [index, trace] of rowsByTable.traces.entries()) {
    const explicit = updates.traces[index];
    const inherit = (source: Record<string, unknown>) => {
      for (const field of ["input", "output"]) {
        if (!explicit.includes(field) && !hasIO(trace[field]) && hasIO(source[field])) {
          trace[field] = source[field];
          inherited[index].push(field);
        }
      }
    };
    if (hasIO(trace.input) && hasIO(trace.output)) continue;
    const traceObs = rowsByTable.observations.filter((o) => o.trace_id === trace.id);
    if (traceObs.length === 0) continue;
    // Prefer the root observation (no parent)
    const root = traceObs.find((o) => !o.parent_observation_id || o.parent_observation_id === "");
    if (root) inherit(root);
    // If still missing, try direct children of the root (or all obs)
    if (!hasIO(trace.input) || !hasIO(trace.output)) {
      const children = root
        ? traceObs.filter((o) => o.parent_observation_id === root.id)
        : traceObs;
      for (const child of children) {
        inherit(child);
        if (hasIO(trace.input) && hasIO(trace.output)) break;
      }
    }
  }

  // Write to SQLite
  const db = getTelemetryDB();
  for (const [table, rows] of Object.entries(rowsByTable)) {
    if (rows.length === 0) continue;
    try {
      await db.insert({
        table,
        records: rows,
        ...(table === "traces" ? { inheritColumns: inherited } : {}),
        ...(table === "traces" || table === "observations"
          ? { updateColumns: updates[table], eventIds: eventIds[table] }
          : {}),
      });
      successes.push(...eventIds[table].map((id) => ({ id, status: 201 })));
    } catch {
      // SQLite 异常可能包含用户数据，不进入响应或日志。
      logger.error(`[processEventBatchLite] Failed to insert into ${table}`, {
        rowCount: rows.length,
      });
      errors.push(
        ...eventIds[table].map((id) => ({
          id,
          status: 500,
          message: "Failed to persist ingestion event",
          error: "InternalServerError",
        })),
      );
      rowsByTable[table] = [];
    }
  }

  return { successes, errors };
};
