/**
 * GET /api/public/v2/metrics integration tests.
 *
 * Seeds a small trace tree + scores via the public ingestion API, then
 * exercises the 4 views (observations / scores-numeric / scores-boolean /
 * scores-categorical), histogram output, high-cardinality groupBy rejection
 * and unknown-field 400s.
 *
 * NOTE: the metrics route is mounted on a dedicated Hono app here — app.ts
 * registration is owned by T6 (out of scope for this task), so the suite
 * replicates app.ts's onError mapping (BaseError → {error, message}).
 */
import { randomUUID } from "node:crypto";
import { BaseError, LangfuseNotFoundError } from "@peri-fuse/shared";
import { logger } from "@peri-fuse/shared/src/server";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LiteServerEnv } from "../auth";
import metricsRoutes from "../routes/metrics-v2";
import { apiPost, basicAuth } from "./helpers";
import { TEST_PROJECT_ID } from "./test-db-paths";

const runId = randomUUID().slice(0, 8);

// Fixed deterministic window: no other suite writes June 2025 data.
const BASE = "2025-06-01T10:00:00.000Z";
const FROM = "2025-06-01T00:00:00.000Z";
const TO = "2025-06-02T00:00:00.000Z";

const traceA = `metrics-ta-${runId}`;
const traceB = `metrics-tb-${runId}`;
const gen1 = `metrics-o1-${runId}`;
const gen2 = `metrics-o2-${runId}`;
const span1 = `metrics-o3-${runId}`;
const event1 = `metrics-o4-${runId}`;
const gen3 = `metrics-o5-${runId}`;
const scoreNameNumeric = `metrics-num-${runId}`;
const scoreNameBoolean = `metrics-bool-${runId}`;
const scoreNameCategorical = `metrics-cat-${runId}`;

function iso(offsetMs: number): string {
  return new Date(new Date(BASE).getTime() + offsetMs).toISOString();
}

function traceEvent(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    type: "trace-create",
    timestamp: BASE,
    body: { id, timestamp: BASE, name, ...extra },
  };
}

function generationEvent(
  id: string,
  traceId: string,
  name: string,
  offsetMs: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id: randomUUID(),
    type: "generation-create",
    timestamp: iso(offsetMs),
    body: {
      id,
      traceId,
      name,
      startTime: iso(offsetMs),
      endTime: iso(offsetMs + 1000),
      ...extra,
    },
  };
}

function spanEvent(
  id: string,
  traceId: string,
  name: string,
  offsetMs: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id: randomUUID(),
    type: "span-create",
    timestamp: iso(offsetMs),
    body: {
      id,
      traceId,
      name,
      startTime: iso(offsetMs),
      endTime: iso(offsetMs + 500),
      ...extra,
    },
  };
}

function eventEvent(id: string, traceId: string, name: string, offsetMs: number) {
  return {
    id: randomUUID(),
    type: "event-create",
    timestamp: iso(offsetMs),
    body: {
      id,
      traceId,
      name,
      startTime: iso(offsetMs),
      level: "WARNING",
    },
  };
}

/**
 * Scores are written directly to the telemetry DB: the ingestion score body
 * has no `timestamp` field, so ingestion rows would carry `now` instead of the
 * deterministic June-2025 window used by this suite.
 */
function insertScore(
  id: string,
  traceId: string,
  name: string,
  value: number,
  dataType: string,
  stringValue: string | null,
  observationId: string | null,
) {
  const now = BASE.replace("T", " ").replace("Z", "");
  return getTelemetryDB().insert({
    table: "scores",
    records: [
      {
        id,
        project_id: TEST_PROJECT_ID,
        trace_id: traceId,
        observation_id: observationId,
        name,
        value,
        string_value: stringValue,
        source: "API",
        comment: null,
        author_user_id: null,
        config_id: null,
        data_type: dataType,
        timestamp: now,
        created_at: now,
        updated_at: now,
        event_ts: now,
        is_deleted: 0,
        environment: "default",
        queue_id: null,
      },
    ],
  });
}

/** Mount the metrics route with app.ts-equivalent error handling. */
function metricsRequest(url: string): Promise<{ status: number; body: any }> {
  const app = new Hono<LiteServerEnv>();
  app.onError((err, c) => {
    if (err instanceof LangfuseNotFoundError) {
      return c.json({ message: err.message }, 404);
    }
    if (err instanceof BaseError) {
      if (!err.isUserError()) logger.error(err);
      return c.json({ error: err.name, message: err.message }, err.httpCode as 500);
    }
    logger.error("Unhandled lite-server error", err);
    return c.json({ message: "Internal Server Error" }, 500);
  });
  app.route("/", metricsRoutes);
  return app
    .request(url, { headers: { Authorization: basicAuth() } })
    .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

function metricsUrl(query: unknown): string {
  return `/api/public/v2/metrics?query=${encodeURIComponent(JSON.stringify(query))}`;
}

describe("metrics v2", () => {
  beforeAll(async () => {
    const res = await apiPost("/api/public/ingestion", {
      batch: [
        traceEvent(traceA, `metrics-trace-a-${runId}`, {
          userId: "metrics-user-1",
          sessionId: "metrics-session-1",
          tags: ["tag-a", "tag-b"],
          release: "1.2.3",
          version: "v1",
          environment: "production",
        }),
        traceEvent(traceB, `metrics-trace-b-${runId}`, {
          userId: "metrics-user-2",
          tags: ["tag-b"],
          release: "2.0.0",
          environment: "staging",
        }),
        generationEvent(gen1, traceA, "metrics-gen-1", 0, {
          level: "DEFAULT",
          model: "gpt-4",
          promptName: "metrics-prompt",
          promptVersion: 2,
          completionStartTime: iso(500),
          // 2s latency (endTime override)
          endTime: iso(2000),
          usage: { input: 100, output: 50, total: 150 },
          costDetails: { input: 0.001, output: 0.002 },
          metadata: { team: "core", budget: 42 },
        }),
        generationEvent(gen2, traceA, "metrics-gen-2", 3600_000, {
          level: "ERROR",
          statusMessage: "boom",
          model: "gpt-4",
          usage: { input: 200, output: 100, total: 300 },
        }),
        // 500ms latency
        spanEvent(span1, traceA, "metrics-span-1", 7200_000, { level: "DEFAULT" }),
        // no end_time → latency NULL
        eventEvent(event1, traceA, "metrics-event-1", 10_800_000),
        // 1.5s latency
        generationEvent(gen3, traceB, "metrics-gen-3", 0, {
          level: "DEFAULT",
          model: "claude-3",
          endTime: iso(1500),
          usage: { input: 10, output: 5, total: 15 },
        }),
        await insertScore(
          `metrics-s1-${runId}`,
          traceA,
          scoreNameNumeric,
          0.9,
          "NUMERIC",
          null,
          gen1,
        ),
        await insertScore(
          `metrics-s2-${runId}`,
          traceA,
          scoreNameNumeric,
          0.5,
          "NUMERIC",
          null,
          null,
        ),
        await insertScore(
          `metrics-s3-${runId}`,
          traceA,
          scoreNameBoolean,
          1,
          "BOOLEAN",
          "True",
          null,
        ),
        await insertScore(
          `metrics-s4-${runId}`,
          traceA,
          scoreNameBoolean,
          0,
          "BOOLEAN",
          "False",
          null,
        ),
        await insertScore(
          `metrics-s5-${runId}`,
          traceB,
          scoreNameBoolean,
          1,
          "BOOLEAN",
          "True",
          null,
        ),
        await insertScore(
          `metrics-s6-${runId}`,
          traceA,
          scoreNameCategorical,
          0,
          "CATEGORICAL",
          "good",
          null,
        ),
        await insertScore(
          `metrics-s7-${runId}`,
          traceA,
          scoreNameCategorical,
          0,
          "CATEGORICAL",
          "bad",
          null,
        ),
      ],
    });
    expect(res.status).toBe(207);
  });

  it("observations view: group by type with count + token sums", async () => {
    const { status, body } = await metricsRequest(
      metricsUrl({
        view: "observations",
        dimensions: [{ field: "type" }],
        metrics: [
          { measure: "count", aggregation: "count" },
          { measure: "inputTokens", aggregation: "sum" },
          { measure: "totalTokens", aggregation: "sum" },
        ],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(status).toBe(200);
    const byType = Object.fromEntries((body.data as any[]).map((r) => [r.type, r]));
    expect(byType.GENERATION.count_count).toBe(3);
    expect(byType.GENERATION.sum_inputTokens).toBe(310);
    expect(byType.GENERATION.sum_totalTokens).toBe(465);
    expect(byType.SPAN.count_count).toBe(1);
    expect(byType.EVENT.count_count).toBe(1);
  });

  it("observations view: trace-derived dimensions and boolean filter", async () => {
    const { status, body } = await metricsRequest(
      metricsUrl({
        view: "observations",
        dimensions: [{ field: "traceName" }, { field: "release" }],
        metrics: [{ measure: "count", aggregation: "count" }],
        filters: [
          { column: "isRootObservation", operator: "=", value: true, type: "boolean" },
          { column: "userId", operator: "=", value: "metrics-user-1", type: "string" },
        ],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].count_count).toBe(4); // all 4 observations of traceA
    expect(body.data[0].traceName).toContain("metrics-trace-a");
    expect(body.data[0].release).toBe("1.2.3");
  });

  it("observations view: starts with / contains operators and metadata filter", async () => {
    const { status, body } = await metricsRequest(
      metricsUrl({
        view: "observations",
        metrics: [{ measure: "count", aggregation: "count" }],
        filters: [
          { column: "name", operator: "starts with", value: "metrics-gen-", type: "string" },
          { column: "metadata", operator: "=", value: "core", key: "team", type: "stringObject" },
        ],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(status).toBe(200);
    expect(body.data[0].count_count).toBe(1); // only gen1 carries the metadata
  });

  it("scores-numeric view: NUMERIC+BOOLEAN segment, count/avg/max on value", async () => {
    const { status, body } = await metricsRequest(
      metricsUrl({
        view: "scores-numeric",
        dimensions: [{ field: "name" }],
        metrics: [
          { measure: "count", aggregation: "count" },
          { measure: "value", aggregation: "avg" },
          { measure: "value", aggregation: "max" },
        ],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(status).toBe(200);
    const byName = Object.fromEntries((body.data as any[]).map((r) => [r.name, r]));
    // BOOLEAN scores are part of the numeric view; CATEGORICAL is excluded.
    expect(byName[scoreNameNumeric].count_count).toBe(2);
    expect(byName[scoreNameNumeric].avg_value).toBeCloseTo(0.7);
    expect(byName[scoreNameNumeric].max_value).toBe(0.9);
    expect(byName[scoreNameBoolean].count_count).toBe(3);
    expect(byName[scoreNameCategorical]).toBeUndefined();
  });

  it("scores-boolean view: true/false breakdown with true-rate avg", async () => {
    const { status, body } = await metricsRequest(
      metricsUrl({
        view: "scores-boolean",
        dimensions: [{ field: "booleanValue" }],
        metrics: [
          { measure: "count", aggregation: "count" },
          { measure: "value", aggregation: "avg" },
        ],
        filters: [{ column: "name", operator: "=", value: scoreNameBoolean, type: "string" }],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ booleanValue: true, count_count: 2, avg_value: 1 }),
        expect.objectContaining({ booleanValue: false, count_count: 1, avg_value: 0 }),
      ]),
    );
  });

  it("scores-categorical view: stringValue grouping", async () => {
    const { status, body } = await metricsRequest(
      metricsUrl({
        view: "scores-categorical",
        dimensions: [{ field: "stringValue" }],
        metrics: [{ measure: "count", aggregation: "count" }],
        filters: [{ column: "name", operator: "=", value: scoreNameCategorical, type: "string" }],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(status).toBe(200);
    const byValue = Object.fromEntries(
      (body.data as any[]).map((r) => [r.stringValue, r.count_count]),
    );
    expect(byValue).toEqual({ good: 1, bad: 1 });
  });

  it("histogram aggregation returns [lower, upper, height] tuples", async () => {
    const { status, body } = await metricsRequest(
      metricsUrl({
        view: "observations",
        metrics: [{ measure: "latency", aggregation: "histogram" }],
        config: { bins: 4 },
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(status).toBe(200);
    const hist = body.data[0].histogram_latency as Array<[number, number, number]>;
    expect(Array.isArray(hist)).toBe(true);
    expect(hist.length).toBeLessThanOrEqual(4);
    const total = hist.reduce((acc, bin) => acc + bin[2], 0);
    expect(total).toBe(4); // 4 observations with end_time in the window
    for (const bin of hist) {
      expect(bin).toHaveLength(3);
      expect(bin[0]).toBeLessThanOrEqual(bin[1]);
      expect(bin[2]).toBeGreaterThanOrEqual(0);
    }
  });

  it("timeDimension buckets rows under time_dimension", async () => {
    const { status, body } = await metricsRequest(
      metricsUrl({
        view: "observations",
        metrics: [{ measure: "count", aggregation: "count" }],
        timeDimension: { granularity: "day" },
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].time_dimension).toBe("2025-06-01");
    expect(body.data[0].count_count).toBe(5);
  });

  it("rejects high-cardinality dimensions in groupBy with 400", async () => {
    for (const field of ["traceId", "id", "userId", "sessionId", "parentObservationId"]) {
      const { status, body } = await metricsRequest(
        metricsUrl({
          view: "observations",
          dimensions: [{ field }],
          metrics: [{ measure: "count", aggregation: "count" }],
          fromTimestamp: FROM,
          toTimestamp: TO,
        }),
      );
      expect(status).toBe(400);
      expect(body.error).toBe("InvalidRequestError");
      expect(body.message).toContain("High cardinality");
    }
  });

  it("allows high-cardinality fields as filters", async () => {
    const { status, body } = await metricsRequest(
      metricsUrl({
        view: "observations",
        metrics: [{ measure: "count", aggregation: "count" }],
        filters: [{ column: "traceId", operator: "=", value: traceA, type: "string" }],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(status).toBe(200);
    expect(body.data[0].count_count).toBe(4);
  });

  it("rejects unknown dimension / measure / view / aggregation with 400", async () => {
    const unknownDimension = await metricsRequest(
      metricsUrl({
        view: "observations",
        dimensions: [{ field: "nope" }],
        metrics: [{ measure: "count", aggregation: "count" }],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(unknownDimension.status).toBe(400);
    expect(unknownDimension.body.message).toContain("Invalid dimension nope");

    const unknownMeasure = await metricsRequest(
      metricsUrl({
        view: "observations",
        metrics: [{ measure: "nope", aggregation: "count" }],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(unknownMeasure.status).toBe(400);
    expect(unknownMeasure.body.message).toContain("Invalid metric nope");

    const unknownView = await metricsRequest(
      metricsUrl({
        view: "traces",
        metrics: [{ measure: "count", aggregation: "count" }],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(unknownView.status).toBe(400);

    const unknownAggregation = await metricsRequest(
      metricsUrl({
        view: "observations",
        metrics: [{ measure: "latency", aggregation: "median" }],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(unknownAggregation.status).toBe(400);

    const unknownFilterColumn = await metricsRequest(
      metricsUrl({
        view: "observations",
        metrics: [{ measure: "count", aggregation: "count" }],
        filters: [{ column: "nope", operator: "=", value: "x", type: "string" }],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(unknownFilterColumn.status).toBe(400);
    expect(unknownFilterColumn.body.message).toContain("Invalid filter column");
  });

  it("rejects incompatible filter types (tags is arrayOptions-only)", async () => {
    const { status, body } = await metricsRequest(
      metricsUrl({
        view: "observations",
        metrics: [{ measure: "count", aggregation: "count" }],
        filters: [{ column: "tags", operator: "contains", value: "tag-a", type: "string" }],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(status).toBe(400);
    expect(body.message).toContain(
      "Filter type 'string' is not supported for dimension type 'string[]'",
    );
  });

  it("rejects malformed JSON query and unknown filter type", async () => {
    const malformed = await metricsRequest("/api/public/v2/metrics?query=%7Bnot-json");
    expect(malformed.status).toBe(400);

    const badType = await metricsRequest(
      metricsUrl({
        view: "observations",
        metrics: [{ measure: "count", aggregation: "count" }],
        filters: [{ column: "name", operator: "=", value: "x", type: "regex" }],
        fromTimestamp: FROM,
        toTimestamp: TO,
      }),
    );
    expect(badType.status).toBe(400);
  });

  afterAll(async () => {
    // This suite seeds a fixed historical window (2025-06-01) so its rows are
    // NOT wiped by dashboard.test.ts's "today" cleanup; remove them here so
    // suites that assert all-time counts (dashboard) never see them regardless
    // of file execution order.
    const telemetry = getTelemetryDB();
    const from = "2025-06-01 00:00:00.000";
    const to = "2025-06-02 00:00:00.000";
    for (const [table, timeCol] of [
      ["traces", "timestamp"],
      ["observations", "start_time"],
      ["scores", "timestamp"],
      ["trace_metrics", "timestamp"],
    ] as const) {
      await telemetry.command({
        query: `DELETE FROM ${table} WHERE project_id = @projectId AND ${timeCol} >= @from AND ${timeCol} < @to`,
        params: { projectId: TEST_PROJECT_ID, from, to },
      });
    }
  });
});
