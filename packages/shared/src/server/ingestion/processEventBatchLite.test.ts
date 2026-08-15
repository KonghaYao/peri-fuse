/**
 * Lite-mode event batch processing tests.
 *
 * Focus: the observation `type` column must be derived from the ingestion
 * event type (e.g. "agent-create" → "AGENT"), mirroring the full-mode
 * worker IngestionService.getObservationType. Regression guard for a bug
 * where every typed create event collapsed to "SPAN" because the code read
 * the (absent) `body.type` field instead of the event type.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared env schema requires CLICKHOUSE_*/S3 vars unless LANGFUSE_MODE is
// "lite". Set it before any module import so processEventBatchLite's logger
// (which imports env) can load in the shared-package test environment.
vi.hoisted(() => {
  process.env.LANGFUSE_MODE = "lite";
});

// Capture records inserted into the telemetry DB.
const { insertMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
}));

vi.mock("../adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapters")>();
  return {
    ...actual,
    getTelemetryDB: () => ({
      query: vi.fn().mockResolvedValue([]),
      command: vi.fn().mockResolvedValue(undefined),
      insert: insertMock,
      queryStream: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

import type { AuthHeaderValidVerificationResultIngestion } from "../auth/types";
import { processEventBatchLite } from "./processEventBatchLite";

const PROJECT_ID = "test-project-lite-ingest";

const authCheck: AuthHeaderValidVerificationResultIngestion = {
  validKey: true,
  scope: {
    projectId: PROJECT_ID,
    accessLevel: "project",
    orgId: undefined,
  },
} as AuthHeaderValidVerificationResultIngestion;

const buildObsEvent = (type: string, name: string) => ({
  id: randomUUID(),
  type,
  timestamp: new Date().toISOString(),
  body: {
    id: randomUUID(),
    traceId: randomUUID(),
    name,
    startTime: new Date().toISOString(),
  },
});

/** Run a batch of observation events and return the inserted obs rows. */
const ingestObservations = async (
  events: Array<{ type: string; name: string }>,
): Promise<Record<string, unknown>[]> => {
  insertMock.mockClear();
  insertMock.mockResolvedValue(undefined);

  const result = await processEventBatchLite(
    events.map((e) => buildObsEvent(e.type, e.name)),
    authCheck,
    {
      attribution: {
        ingestionApiKey: "pk-test",
        ingestionSdkName: "test-sdk",
        ingestionSdkVersion: "1.0.0",
      },
    },
  );

  expect(result.errors).toEqual([]);

  const obsInsert = insertMock.mock.calls.find(
    (call) => (call[0] as { table: string }).table === "observations",
  );
  return obsInsert ? ((obsInsert[0] as { records: Record<string, unknown>[] }).records ?? []) : [];
};

describe("processEventBatchLite - observation type mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["agent-create", "AGENT"],
    ["tool-create", "TOOL"],
    ["chain-create", "CHAIN"],
    ["retriever-create", "RETRIEVER"],
    ["evaluator-create", "EVALUATOR"],
    ["embedding-create", "EMBEDDING"],
    ["guardrail-create", "GUARDRAIL"],
    ["generation-create", "GENERATION"],
    ["span-create", "SPAN"],
    ["event-create", "EVENT"],
  ])("maps %s to observation type %s", async (eventType, expectedType) => {
    const rows = await ingestObservations([
      { type: eventType, name: `${expectedType.toLowerCase()}-obs` },
    ]);

    expect(rows.length).toBe(1);
    expect(rows[0]?.type).toBe(expectedType);
  });

  it("maps all typed create events in a single batch correctly", async () => {
    const rows = await ingestObservations([
      { type: "agent-create", name: "agent" },
      { type: "tool-create", name: "tool" },
      { type: "generation-create", name: "generation" },
      { type: "span-create", name: "span" },
    ]);

    expect(rows.length).toBe(4);
    const typesByName = Object.fromEntries(rows.map((r) => [r.name as string, r.type as string]));
    expect(typesByName).toEqual({
      agent: "AGENT",
      tool: "TOOL",
      generation: "GENERATION",
      span: "SPAN",
    });
  });

  it("honours explicit body.type for legacy observation-create", async () => {
    insertMock.mockClear();
    insertMock.mockResolvedValue(undefined);

    const result = await processEventBatchLite(
      [
        {
          id: randomUUID(),
          type: "observation-create",
          timestamp: new Date().toISOString(),
          body: {
            id: randomUUID(),
            traceId: randomUUID(),
            type: "GENERATION",
            name: "legacy-obs",
            startTime: new Date().toISOString(),
          },
        },
      ],
      authCheck,
      {
        attribution: {
          ingestionApiKey: "pk-test",
          ingestionSdkName: "test-sdk",
          ingestionSdkVersion: "1.0.0",
        },
      },
    );

    expect(result.errors).toEqual([]);
    const obsInsert = insertMock.mock.calls.find(
      (call) => (call[0] as { table: string }).table === "observations",
    );
    const rows = (obsInsert?.[0] as { records: Record<string, unknown>[] } | undefined)?.records;
    expect(rows?.[0]?.type).toBe("GENERATION");
  });
});

describe("processEventBatchLite - score rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Run one score event and return the inserted scores row. */
  const ingestScore = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    insertMock.mockClear();
    insertMock.mockResolvedValue(undefined);

    const result = await processEventBatchLite(
      [
        {
          id: randomUUID(),
          type: "score-create",
          timestamp: new Date().toISOString(),
          body,
        },
      ],
      authCheck,
      {
        attribution: {
          ingestionApiKey: "pk-test",
          ingestionSdkName: "test-sdk",
          ingestionSdkVersion: "1.0.0",
        },
      },
    );

    expect(result.errors).toEqual([]);
    const scoreInsert = insertMock.mock.calls.find(
      (call) => (call[0] as { table: string }).table === "scores",
    );
    const rows = (scoreInsert?.[0] as { records: Record<string, unknown>[] } | undefined)?.records;
    expect(rows).toHaveLength(1);
    return rows![0];
  };

  it("writes CORRECTION text to string_value with a 0 value placeholder", async () => {
    const row = await ingestScore({
      id: randomUUID(),
      traceId: randomUUID(),
      name: "correction",
      value: "correct this output",
      dataType: "CORRECTION",
    });

    expect(row.data_type).toBe("CORRECTION");
    expect(row.value).toBe(0);
    expect(row.string_value).toBe("correct this output");
  });

  it("writes session_id and serialized metadata for session-level scores", async () => {
    const row = await ingestScore({
      id: randomUUID(),
      sessionId: "sess-1",
      name: "session-score",
      value: 0.9,
      dataType: "NUMERIC",
      metadata: { source: "eval" },
    });

    expect(row.trace_id).toBeNull();
    expect(row.session_id).toBe("sess-1");
    expect(row.metadata).toBe(JSON.stringify({ source: "eval" }));
  });
});
