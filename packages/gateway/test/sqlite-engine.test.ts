/**
 * Gateway coverage for the optional `bun:sqlite` engine (`PERIFUSE_ENGINE=sqlite`).
 *
 * Activates only under Bun (the sqlite engine requires Bun >= 1.4.0). The suite
 * sets `PERIFUSE_ENGINE=sqlite` before the first `getDb()` call, so sync
 * construction, migrations, Drizzle transactions and project scoping all run
 * through the sqlite adapter.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rejectSql } from "@peri-fuse/shared/src/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiKey, dailySpend, provider, spendLog } from "../src/db/schema.js";
import type { SpendEvent } from "../src/spend/flusher.js";

const onBun = typeof process.versions.bun === "string";
const PROJECT_A = "sqlite-project-a";
const PROJECT_B = "sqlite-project-b";
const RECORD_OPTIONS = { logRequests: true, logMaxBodySize: 10_240 };
const API_KEY_UPDATE = /UPDATE(?: OR REPLACE)?(?: INTO)?[\s"\x60]+ApiKey/i;

function event(overrides: Partial<SpendEvent> = {}): SpendEvent {
  return {
    projectId: PROJECT_A,
    callType: "completion",
    apiKey: "sqlite-key-a",
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

describe.skipIf(!onBun)("gateway sqlite engine", () => {
  let directory: string;
  let database: typeof import("../src/db.js");
  let recordSpend: typeof import("../src/spend/record.js").recordSpend;
  let isSqliteDatabase: typeof import("@peri-fuse/shared/src/db/local").isSqliteDatabase;
  const savedEnvironment = new Map<string, string | undefined>();

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "gateway-sqlite-engine-"));
    for (const key of [
      "PERIFUSE_ENGINE",
      "GATEWAY_DB_URL",
      "DATABASE_URL",
      "SALT",
      "GATEWAY_ENCRYPTION_KEY",
    ]) {
      savedEnvironment.set(key, process.env[key]);
    }
    process.env.PERIFUSE_ENGINE = "sqlite";
    process.env.GATEWAY_DB_URL = `file:${join(directory, "gateway.db")}`;
    process.env.SALT = "gateway-sqlite-salt";
    process.env.GATEWAY_ENCRYPTION_KEY = "9".repeat(64);
    database = await import("../src/db.js");
    ({ recordSpend } = await import("../src/spend/record.js"));
    ({ isSqliteDatabase } = await import("@peri-fuse/shared/src/db/local"));
  });

  afterAll(async () => {
    await database?.closeDb();
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("constructs getDb() synchronously on the sqlite engine and applies migrations", async () => {
    const db = database.getDb();
    expect(isSqliteDatabase(db.$client)).toBe(true);
    await database.ensureSchema();
    expect(await db.select().from(provider).all()).toEqual([]);
  });

  it("rolls the whole recordSpend transaction back when the last statement fails", async () => {
    const db = database.getDb();
    await db
      .insert(apiKey)
      .values({ id: "sqlite-key-a", projectId: PROJECT_A, publicKey: "sqlite-key-a" })
      .run();

    await recordSpend(db, event({ spend: 3 }), RECORD_OPTIONS);
    expect(
      await db.select().from(spendLog).where(eq(spendLog.projectId, PROJECT_A)).all(),
    ).toHaveLength(1);
    expect(
      await db.select().from(dailySpend).where(eq(dailySpend.projectId, PROJECT_A)).get(),
    ).toMatchObject({ apiRequests: 1, spend: 3 });
    expect((await db.select().from(apiKey).where(eq(apiKey.id, "sqlite-key-a")).get())?.spend).toBe(
      3,
    );

    // Fail the last statement, after the log and the daily aggregate were written.
    const fault = rejectSql(db.$client, API_KEY_UPDATE, vi);
    try {
      await expect(recordSpend(db, event({ spend: 5 }), RECORD_OPTIONS)).rejects.toThrow(
        "synthetic database failure",
      );
    } finally {
      fault.mockRestore();
    }

    expect(
      await db.select().from(spendLog).where(eq(spendLog.projectId, PROJECT_A)).all(),
    ).toHaveLength(1);
    expect(
      await db.select().from(dailySpend).where(eq(dailySpend.projectId, PROJECT_A)).get(),
    ).toMatchObject({ apiRequests: 1, spend: 3 });
    expect((await db.select().from(apiKey).where(eq(apiKey.id, "sqlite-key-a")).get())?.spend).toBe(
      3,
    );
  });

  it("serializes concurrent debits without losing updates or crossing projects", async () => {
    const db = database.getDb();
    await db
      .insert(apiKey)
      .values({ id: "sqlite-key-b", projectId: PROJECT_B, publicKey: "sqlite-key-b" })
      .run();

    await Promise.all(
      Array.from({ length: 10 }, () =>
        recordSpend(
          db,
          event({ projectId: PROJECT_B, apiKey: "sqlite-key-b", spend: 1 }),
          RECORD_OPTIONS,
        ),
      ),
    );

    expect((await db.select().from(apiKey).where(eq(apiKey.id, "sqlite-key-b")).get())?.spend).toBe(
      10,
    );
    expect(
      await db.select().from(dailySpend).where(eq(dailySpend.projectId, PROJECT_B)).get(),
    ).toMatchObject({ apiRequests: 10, spend: 10 });
    expect(
      await db.select().from(spendLog).where(eq(spendLog.projectId, PROJECT_B)).all(),
    ).toHaveLength(10);

    // Project A must neither see nor absorb project B writes.
    expect(
      await db.select().from(spendLog).where(eq(spendLog.projectId, PROJECT_A)).all(),
    ).toHaveLength(1);
    expect((await db.select().from(apiKey).where(eq(apiKey.id, "sqlite-key-a")).get())?.spend).toBe(
      3,
    );
  });

  it("closes and reopens the same sqlite file with committed rows intact", async () => {
    await database.closeDb();
    const reopened = database.getDb();
    expect(isSqliteDatabase(reopened.$client)).toBe(true);
    await database.ensureSchema();
    expect(
      await reopened.select().from(spendLog).where(eq(spendLog.projectId, PROJECT_A)).all(),
    ).toHaveLength(1);
    expect(
      (await reopened.select().from(apiKey).where(eq(apiKey.id, "sqlite-key-b")).get())?.spend,
    ).toBe(10);
  });
});
