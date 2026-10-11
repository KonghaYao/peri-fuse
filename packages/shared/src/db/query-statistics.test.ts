import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type LocalDatabase, openLocalDatabase } from "./local";
import { ensureQueryStatistics } from "./query-statistics";

const directories: string[] = [];
const temporaryPath = () => {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-query-statistics-"));
  directories.push(directory);
  return join(directory, "database.turso.db");
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// Mirrors the telemetry observations shape: composite primary key plus a
// secondary index on (project_id, v) — the planner picks the wrong one when
// no statistics exist (upstream tursodatabase/turso#8664).
const OBS_SCHEMA = [
  "CREATE TABLE obs (id TEXT NOT NULL, project_id TEXT NOT NULL, v TEXT, payload BLOB, PRIMARY KEY (project_id, id))",
  "CREATE INDEX idx_obs_project_v ON obs (project_id, v)",
].join("; ");

async function seedObservations(db: LocalDatabase, rows: number): Promise<void> {
  const payload = Buffer.alloc(1024, 1);
  for (let index = 0; index < rows; index++) {
    await db.run("INSERT INTO obs VALUES(?,?,?,?)", `id-${index}`, "p1", `v-${index}`, payload);
  }
}

async function pointLookupPlan(db: LocalDatabase): Promise<string> {
  const plan = (await db.all(
    "EXPLAIN QUERY PLAN SELECT id, project_id, v FROM obs WHERE project_id=? AND id=?",
    "p1",
    "id-250",
  )) as { detail?: unknown }[];
  return plan.map((row) => String(row.detail ?? "")).join(" | ");
}

describe("query statistics maintenance", () => {
  it("analyzes a non-empty table that lacks statistics and restores the unique-index plan", async () => {
    const db = await openLocalDatabase(temporaryPath());
    try {
      await db.exec(OBS_SCHEMA);
      await seedObservations(db, 500);
      const analyzed = await ensureQueryStatistics(db);
      expect(analyzed).toEqual(["obs"]);
      expect(await pointLookupPlan(db)).toContain("sqlite_autoindex_obs_1");
    } finally {
      await db.close();
    }
  });

  it("skips empty tables because ANALYZE records no statistics for them", async () => {
    const db = await openLocalDatabase(temporaryPath());
    try {
      await db.exec(OBS_SCHEMA);
      expect(await ensureQueryStatistics(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("skips tables with existing statistics and internal tables on later passes", async () => {
    const db = await openLocalDatabase(temporaryPath());
    try {
      await db.exec(OBS_SCHEMA);
      await db.exec(
        "CREATE TABLE _internal (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO _internal VALUES(1,'x')",
      );
      await seedObservations(db, 500);
      expect(await ensureQueryStatistics(db)).toEqual(["obs"]);
      expect(await ensureQueryStatistics(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
