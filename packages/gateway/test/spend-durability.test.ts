import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiKey, dailySpend, spendLog } from "../src/db/schema.js";
import type { SpendEvent } from "../src/spend/flusher.js";

const PROJECT_A = "durable-a";
const PROJECT_B = "durable-b";

function event(overrides: Partial<SpendEvent> = {}): SpendEvent {
  return {
    projectId: PROJECT_A,
    callType: "completion",
    apiKey: "shared-imported-key",
    spend: 1,
    promptTokens: 2,
    completionTokens: 3,
    totalTokens: 5,
    startTime: new Date("2026-09-01T00:00:00Z"),
    endTime: new Date("2026-09-01T00:00:01Z"),
    model: "test-model",
    provider: "test-provider",
    status: "success",
    ...overrides,
  };
}

describe("durable bounded spend accounting", () => {
  let directory: string;
  let database: typeof import("../src/db.js");
  let SpendFlusher: typeof import("../src/spend/flusher.js").SpendFlusher;
  let SpendWriteError: typeof import("../src/spend/flusher.js").SpendWriteError;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "gateway-spend-durable-"));
    process.env.GATEWAY_DB_URL = `file:${join(directory, "gateway.db")}`;
    database = await import("../src/db.js");
    database.ensureSchema();
    ({ SpendFlusher, SpendWriteError } = await import("../src/spend/flusher.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const db = database.getDb();
    for (const projectId of [PROJECT_A, PROJECT_B]) {
      db.delete(spendLog).where(eq(spendLog.projectId, projectId)).run();
      db.delete(dailySpend).where(eq(dailySpend.projectId, projectId)).run();
      db.delete(apiKey).where(eq(apiKey.projectId, projectId)).run();
    }
  });

  afterAll(() => {
    database.closeDb();
    rmSync(directory, { recursive: true, force: true });
  });

  it("commits 2500 events beyond the old SQLite parameter limit without retaining them", async () => {
    const flusher = new SpendFlusher();
    for (let i = 0; i < 2500; i++) flusher.enqueue(event());
    await flusher.flushAll();
    const db = database.getDb();
    const logs = db.select({ id: spendLog.id }).from(spendLog).all();
    const daily = db.select().from(dailySpend).get();
    expect(logs).toHaveLength(2500);
    expect(daily).toMatchObject({ apiRequests: 2500, spend: 2500, promptTokens: 5000 });
    expect(flusher.stats()).toEqual({ accepted: 2500, failures: 0, pending: 0 });
    // Compatibility flush calls cannot apply accounting a second time.
    await Promise.all([flusher.flush(), flusher.flushDaily(), flusher.flushAll()]);
    expect(db.select().from(dailySpend).get()?.apiRequests).toBe(2500);
  });

  it("rejects persistent write failure without partial accounting or memory backlog, then recovers", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = database.getDb();
    db.insert(apiKey)
      .values({ id: "configured-a", projectId: PROJECT_A, publicKey: "shared-imported-key" })
      .run();
    // Fail the last statement, after both the log and aggregate have been written.
    db.run(
      sql.raw(`CREATE TRIGGER reject_key_spend BEFORE UPDATE ON ApiKey
      BEGIN SELECT RAISE(ABORT, 'injected persistent storage failure'); END`),
    );
    const flusher = new SpendFlusher();
    try {
      for (let i = 0; i < 200; i++) {
        expect(() => flusher.enqueue(event())).toThrow(SpendWriteError);
      }
      expect(flusher.stats()).toEqual({ accepted: 0, failures: 200, pending: 0 });
      expect(db.select().from(spendLog).all()).toHaveLength(0);
      expect(db.select().from(dailySpend).all()).toHaveLength(0);
      expect(db.select().from(apiKey).get()?.spend).toBe(0);
    } finally {
      db.run(sql.raw("DROP TRIGGER reject_key_spend"));
    }
    flusher.enqueue(event());
    expect(db.select().from(spendLog).all()).toHaveLength(1);
    expect(db.select().from(dailySpend).get()).toMatchObject({ spend: 1, apiRequests: 1 });
    expect(db.select().from(apiKey).get()?.spend).toBe(1);
  });

  it("refuses admission when SQLite is read-only and permits it after recovery", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = database.getDb();
    const flusher = new SpendFlusher();
    db.run(sql.raw("PRAGMA query_only = ON"));
    try {
      expect(() => flusher.assertWritable()).toThrow(SpendWriteError);
    } finally {
      db.run(sql.raw("PRAGMA query_only = OFF"));
    }
    expect(() => flusher.assertWritable()).not.toThrow();
    expect(db.select().from(spendLog).all()).toHaveLength(0);
  });

  it("keeps empty and identical imported keys isolated by project, including key budgets", () => {
    const db = database.getDb();
    db.insert(apiKey)
      .values({ id: "configured-b", projectId: PROJECT_B, publicKey: "shared-imported-key" })
      .run();
    const flusher = new SpendFlusher();
    for (const key of ["", "shared-imported-key"]) {
      flusher.enqueue(event({ apiKey: key, projectId: PROJECT_A, spend: 1 }));
      flusher.enqueue(event({ apiKey: key, projectId: PROJECT_B, spend: 7 }));
    }
    const rowsA = db.select().from(dailySpend).where(eq(dailySpend.projectId, PROJECT_A)).all();
    const rowsB = db.select().from(dailySpend).where(eq(dailySpend.projectId, PROJECT_B)).all();
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(2);
    expect(rowsA.map((row) => row.spend)).toEqual([1, 1]);
    expect(rowsB.map((row) => row.spend)).toEqual([7, 7]);
    expect(db.select().from(apiKey).get()?.spend).toBe(7);
  });

  it("preserves accounting with request logging disabled and bounds logged UTF-8 bodies", () => {
    const db = database.getDb();
    new SpendFlusher({ logRequests: false }).enqueue(event());
    expect(db.select().from(spendLog).all()).toHaveLength(0);
    expect(db.select().from(dailySpend).get()?.spend).toBe(1);
    new SpendFlusher({ logMaxBodySize: 7 }).enqueue(
      event({ messages: "中文内容很长", response: "hello world", errorMessage: "123456789" }),
    );
    const row = db.select().from(spendLog).get()!;
    expect(row.messages).toBe("中文");
    expect(row.response).toBe("hello w");
    expect(row.errorMessage).toBe("1234567");
    expect(Buffer.byteLength(row.messages!)).toBeLessThanOrEqual(7);
    expect(db.select().from(dailySpend).get()?.spend).toBe(2);
  });

  it("migrates an existing daily index without losing rows and survives database reopen", () => {
    const flusher = new SpendFlusher();
    flusher.enqueue(event());
    const db = database.getDb();
    db.run(sql.raw("DROP INDEX DailySpend_projectId_apiKey_date_model_provider_key"));
    db.run(
      sql.raw(`CREATE UNIQUE INDEX DailySpend_apiKey_date_model_provider_key
      ON DailySpend (apiKey, date, model, provider)`),
    );
    database.closeDb();
    database.ensureSchema();
    database.ensureSchema();
    flusher.enqueue(event({ projectId: PROJECT_B }));
    expect(database.getDb().select().from(dailySpend).all()).toHaveLength(2);
    expect(database.getDb().select().from(spendLog).all()).toHaveLength(2);
  });

  it("does not allocate timers when started repeatedly", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const flusher = new SpendFlusher();
    flusher.start();
    flusher.start();
    flusher.stop();
    flusher.start();
    flusher.stop();
    expect(interval).not.toHaveBeenCalled();
  });
});
