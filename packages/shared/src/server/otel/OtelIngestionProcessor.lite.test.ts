/**
 * OTel Lite Mode Tests
 *
 * Verifies that in lite mode (LANGFUSE_MODE=lite), the OTel ingestion
 * processor bypasses S3 + Redis queue and processes spans inline via
 * processEventBatchLite → SQLite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock isLiteMode before importing the processor
const { isLiteModeMock } = vi.hoisted(() => ({
  isLiteModeMock: vi.fn(),
}));

vi.mock("../adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapters")>();
  return {
    ...actual,
    isLiteMode: isLiteModeMock,
  };
});

// Mock processEventBatchLite
const { processEventBatchLiteMock } = vi.hoisted(() => ({
  processEventBatchLiteMock: vi.fn(),
}));

vi.mock("../ingestion/processEventBatchLite.js", () => ({
  processEventBatchLite: processEventBatchLiteMock,
}));

// Mock S3 client to ensure it's NOT called in lite mode
const { uploadJsonMock } = vi.hoisted(() => ({
  uploadJsonMock: vi.fn(),
}));

vi.mock("../s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../s3")>();
  return {
    ...actual,
    getS3EventStorageClient: () => ({
      uploadJson: uploadJsonMock,
    }),
  };
});

// Mock redis to prevent connection issues
vi.mock("../redis/redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../redis/redis")>()),
  redis: { set: vi.fn().mockResolvedValue("OK") },
}));

// Mock OtelIngestionQueue
const { queueAddMock } = vi.hoisted(() => ({
  queueAddMock: vi.fn(),
}));

vi.mock("../redis/otelIngestionQueue", () => ({
  OtelIngestionQueue: {
    getInstance: () => ({
      add: queueAddMock,
    }),
  },
}));

import { OtelIngestionProcessor, type ResourceSpan } from "./OtelIngestionProcessor";

const PROJECT_ID = "test-project-otel-lite";
const PUBLIC_KEY = "pk-test-otel-lite";

const createProcessor = () =>
  new OtelIngestionProcessor({
    projectId: PROJECT_ID,
    publicKey: PUBLIC_KEY,
    sdkName: "python",
    sdkVersion: "3.8.1",
  });

const buildTestResourceSpans = (): ResourceSpan[] => [
  {
    resource: {
      attributes: [{ key: "service.name", value: { stringValue: "otel-lite-test" } }],
    },
    scopeSpans: [
      {
        scope: { name: "test-scope", version: "1.0.0" },
        spans: [
          {
            traceId: Buffer.from("0af7651916cd43dd8448eb211c80319c", "hex"),
            spanId: Buffer.from("b7ad6b7169203331", "hex"),
            name: "test-generation",
            kind: 1,
            startTimeUnixNano: "1753456800000000000",
            endTimeUnixNano: "1753456801000000000",
            attributes: [
              {
                key: "langfuse.observation.type",
                value: { stringValue: "generation" },
              },
              {
                key: "gen_ai.request.model",
                value: { stringValue: "gpt-4" },
              },
            ],
            status: { code: 1 },
          },
        ],
      },
    ],
  },
];

describe("OtelIngestionProcessor - Lite Mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processEventBatchLiteMock.mockResolvedValue({
      successes: [
        { id: "trace-event", status: 201 },
        { id: "obs-event", status: 201 },
      ],
      errors: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("publishToOtelIngestionQueue", () => {
    it("should process inline via processEventBatchLite in lite mode", async () => {
      isLiteModeMock.mockReturnValue(true);

      const processor = createProcessor();
      const resourceSpans = buildTestResourceSpans();

      const result = await processor.publishToOtelIngestionQueue(resourceSpans);

      // Verify processEventBatchLite was called
      expect(processEventBatchLiteMock).toHaveBeenCalledTimes(1);

      // Verify the events passed to processEventBatchLite
      const [events, authCheck, options] = processEventBatchLiteMock.mock.calls[0] as [
        unknown[],
        unknown,
        unknown,
      ];

      // Should have converted OTel spans to ingestion events
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      // Verify auth check structure
      expect(authCheck).toEqual({
        validKey: true,
        scope: {
          projectId: PROJECT_ID,
          accessLevel: "project",
          orgId: undefined,
        },
      });

      // Verify options include attribution
      expect(options).toMatchObject({
        attribution: {
          ingestionApiKey: PUBLIC_KEY,
          ingestionSdkName: "python",
          ingestionSdkVersion: "3.8.1",
        },
      });

      // Verify result is passed through
      expect(result).toEqual({
        successes: [
          { id: "trace-event", status: 201 },
          { id: "obs-event", status: 201 },
        ],
        errors: [],
      });
    });

    it("should NOT call S3 or queue in lite mode", async () => {
      isLiteModeMock.mockReturnValue(true);

      const processor = createProcessor();
      await processor.publishToOtelIngestionQueue(buildTestResourceSpans());

      // S3 should NOT be called
      expect(uploadJsonMock).not.toHaveBeenCalled();

      // Queue should NOT be called
      expect(queueAddMock).not.toHaveBeenCalled();
    });

    it("should return empty result for empty spans in lite mode", async () => {
      isLiteModeMock.mockReturnValue(true);

      const processor = createProcessor();
      const result = await processor.publishToOtelIngestionQueue([]);

      expect(result).toEqual({ successes: [], errors: [] });
      expect(processEventBatchLiteMock).not.toHaveBeenCalled();
    });

    it("should use S3 + queue in normal mode", async () => {
      isLiteModeMock.mockReturnValue(false);
      uploadJsonMock.mockResolvedValue(undefined);
      queueAddMock.mockResolvedValue(undefined);

      const processor = createProcessor();
      await processor.publishToOtelIngestionQueue(buildTestResourceSpans());

      // S3 SHOULD be called in normal mode
      expect(uploadJsonMock).toHaveBeenCalledTimes(1);

      // Queue SHOULD be called in normal mode
      expect(queueAddMock).toHaveBeenCalledTimes(1);

      // processEventBatchLite should NOT be called
      expect(processEventBatchLiteMock).not.toHaveBeenCalled();
    });
  });

  describe("processToIngestionEvents conversion", () => {
    it("should convert OTel spans to trace-create and observation events", async () => {
      isLiteModeMock.mockReturnValue(true);

      const processor = createProcessor();
      await processor.publishToOtelIngestionQueue(buildTestResourceSpans());

      const [events] = processEventBatchLiteMock.mock.calls[0] as [
        Array<{ type: string; body: Record<string, unknown> }>,
      ];

      // Should have trace-create event
      const traceEvents = events.filter((e) => e.type === "trace-create");
      expect(traceEvents.length).toBe(1);
      expect(traceEvents[0]?.body?.id).toBe("0af7651916cd43dd8448eb211c80319c");

      // Should have observation event (span-create or generation-create)
      const obsEvents = events.filter(
        (e) =>
          e.type === "span-create" || e.type === "generation-create" || e.type === "event-create",
      );
      expect(obsEvents.length).toBe(1);
    });
  });
});
