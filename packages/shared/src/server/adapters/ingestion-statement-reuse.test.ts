import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";

const time = "2026-01-02 00:00:00.000";
const newer = "2026-01-03 00:00:00.000";

const adapterAt = (prefix: string) =>
  new SQLiteTelemetryAdapter(join(mkdtempSync(join(tmpdir(), prefix)), "telemetry.db"));

const envelope = (
  project: string,
  id: string,
  eventTs: string,
  updatedAt: string,
  fields: Record<string, unknown> = {},
) => ({ project_id: project, id, event_ts: eventTs, updated_at: updatedAt, ...fields });

/**
 * Replays an ingestion-shaped workload: out-of-order envelopes, replays, a
 * delete followed by a rewrite, the same id under two projects, and commands
 * that reuse one SQL text with different values. Every wall-clock column the
 * workload can pin is pinned, so only `datetime('now')` defaults are left.
 */
async function replayIngestion(target: SQLiteTelemetryAdapter): Promise<void> {
  await target.insert({
    table: "traces",
    records: [
      envelope("p", "t1", time, time, {
        name: "first",
        timestamp: time,
        input: "one",
        created_at: time,
      }),
    ],
    updateColumns: [["name", "timestamp", "input"]],
    eventIds: ["a"],
  });
  const stale = envelope("p", "t1", time, newer, {
    name: "stale",
    timestamp: time,
    output: "late",
    created_at: time,
  });
  const replay = {
    table: "traces",
    records: [stale],
    updateColumns: [["name", "output", "timestamp"]],
    eventIds: ["z"],
  };
  await target.insert(replay);
  await target.insert(replay);
  await target.insert({
    table: "traces",
    records: [
      envelope("p", "t2", newer, newer, { name: "second", timestamp: newer, created_at: newer }),
      stale,
      envelope("q", "t1", time, time, { name: "isolated", timestamp: time, created_at: time }),
    ],
    updateColumns: [
      ["name", "timestamp"],
      ["name", "output", "timestamp"],
      ["name", "timestamp"],
    ],
    eventIds: ["b", "z", "b"],
  });
  await target.command({ query: "DELETE FROM traces WHERE project_id='p' AND id='t2'" });
  await target.insert({
    table: "traces",
    records: [
      envelope("p", "t2", newer, newer, { name: "rewritten", timestamp: newer, created_at: newer }),
    ],
    updateColumns: [["name", "timestamp"]],
    eventIds: ["c"],
  });
  const rename = (name: string) =>
    target.command({
      query: "UPDATE traces SET name=@name WHERE project_id='p' AND id='t2'",
      params: { name },
    });
  await rename("first rename");
  await rename("second rename");
  await target.mergeInsert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o1",
        trace_id: "t1",
        type: "GENERATION",
        name: "obs",
        start_time: time,
        event_ts: time,
        updated_at: time,
        created_at: time,
        usage_details: '{"input":3}',
      },
    ],
  });
  await target.insert({
    table: "observations",
    records: [
      {
        project_id: "p",
        id: "o2",
        trace_id: "t1",
        type: "SPAN",
        name: "obs2",
        start_time: newer,
        event_ts: newer,
        updated_at: newer,
        created_at: newer,
      },
    ],
    updateColumns: [["name", "start_time"]],
    eventIds: ["d"],
  });
  await target.commandBatch(
    [{ query: "UPDATE traces SET name='never' WHERE project_id='p' AND id='t1'" }],
    { query: "SELECT 1 FROM traces WHERE project_id='p' AND id='missing'" },
  );
}

/** `datetime('now')` columns cannot be pinned by the workload; mask them before comparing. */
const WALL_CLOCK_COLUMNS: Record<string, string[]> = {
  search_dirty: ["next_attempt_at"],
  search_index_state: ["updated_at"],
};

/** Serializes every table in primary-key order so two runs can be compared. */
async function dumpDatabase(target: SQLiteTelemetryAdapter): Promise<Record<string, string[]>> {
  const db = target.getDatabase();
  const tables = (await db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )) as { name: string }[];
  const dump: Record<string, string[]> = {};
  for (const { name } of tables) {
    const info = (await db.all(`PRAGMA table_info(${name})`)) as { name: string; pk: number }[];
    const keys = info
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    const rows = (await db.all(
      `SELECT * FROM ${name}${keys.length ? ` ORDER BY ${keys.join(",")}` : ""}`,
    )) as Record<string, unknown>[];
    dump[name] = rows.map((row) => {
      const masked = { ...row };
      for (const column of WALL_CLOCK_COLUMNS[name] ?? []) masked[column] = "<now>";
      return JSON.stringify(masked);
    });
  }
  return dump;
}

/**
 * Keeps every call on the pre-cache driver path: the injected `prepare` fails,
 * which is the documented degradation of the statement cache, so the adapter
 * runs through `tx.run/get/all` exactly as it did before the cache existed.
 */
function withoutStatementReuse(target: SQLiteTelemetryAdapter) {
  const db = target.getDatabase();
  const transaction = db.transactionAsync.bind(db);
  const blocked = { attempts: 0 };
  const spy = vi.spyOn(db, "transactionAsync").mockImplementation((callback) =>
    transaction(async (tx, ...args) => {
      const proxy = new Proxy(tx, {
        get(handle, name) {
          if (name === "prepare")
            return () => {
              blocked.attempts += 1;
              throw new Error("STATEMENT_CACHE_DISABLED");
            };
          const value = Reflect.get(handle, name);
          return typeof value === "function" ? value.bind(handle) : value;
        },
      });
      return callback(proxy, ...args);
    }),
  );
  return { blocked, restore: () => spy.mockRestore() };
}

it("writes identical tables with and without statement reuse", async () => {
  const reused = adapterAt("peri-statement-cache-on-");
  const plain = adapterAt("peri-statement-cache-off-");
  const disabled = withoutStatementReuse(plain);
  try {
    await reused.initialize();
    await plain.initialize();
    await replayIngestion(reused);
    await replayIngestion(plain);
    const cached = await dumpDatabase(reused);
    const direct = await dumpDatabase(plain);
    // Non-vacuous: the workload fills many tables and both paths wrote them.
    expect(Object.keys(cached).length).toBeGreaterThan(12);
    expect(Object.values(cached).filter((rows) => rows.length > 0).length).toBeGreaterThan(6);
    expect(cached.traces).toHaveLength(3);
    expect(cached.observations).toHaveLength(2);
    expect(cached.ingestion_field_versions).toHaveLength(4);
    expect(cached.daily_stats_dirty).toHaveLength(3);
    // The uncached run really took the fallback path.
    expect(disabled.blocked.attempts).toBeGreaterThan(0);
    console.info(
      JSON.stringify({
        path: "no-reuse",
        tables: Object.keys(cached).length,
        populated: Object.keys(cached).filter((name) => cached[name].length > 0),
        rows: Object.fromEntries(Object.entries(cached).map(([name, rows]) => [name, rows.length])),
      }),
    );
    const renamed = (await reused
      .getDatabase()
      .get("SELECT name FROM traces WHERE project_id='p' AND id='t2'")) as { name: string };
    expect(renamed).toEqual({ name: "second rename" });
    expect(direct).toEqual(cached);
  } finally {
    disabled.restore();
    await reused.close();
    await plain.close();
  }
});
