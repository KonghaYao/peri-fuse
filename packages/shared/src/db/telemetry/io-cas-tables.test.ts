import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { initializeTelemetrySchema } from "../../server/adapters/sqlite-telemetry-schema";
import {
  applyLocalMigrations,
  findLocalPackageRoot,
  openLocalDatabase,
  readLocalMigrations,
} from "../local";
import { IO_CAS_ROOTS_INDEX_NAME, IO_CAS_ROOTS_INDEX_SQL } from "./io-cas-tables";

const db = await openLocalDatabase(":memory:");
const migrations = readLocalMigrations(join(findLocalPackageRoot(__dirname), "telemetry-drizzle"));
const CHECK_FAILURE = /CHECK constraint failed/i;
const UNIQUE_FAILURE = /UNIQUE constraint failed/i;

afterAll(async () => await db.close());

const hash = (fill: number) => Buffer.alloc(32, fill);

async function insertChunk(
  overrides: Partial<{
    projectId: string;
    contentHash: Buffer;
    codec: number;
    rawSize: number;
    payload: Buffer;
    markEpoch: number;
  }> = {},
) {
  return db.run(
    `INSERT INTO io_cas_chunks (project_id, content_hash, codec, raw_size, payload, mark_epoch)
     VALUES (?, ?, ?, ?, ?, ?)`,
    overrides.projectId ?? "project-a",
    overrides.contentHash ?? hash(1),
    overrides.codec ?? 0,
    overrides.rawSize ?? 32,
    overrides.payload ?? Buffer.from("hello message"),
    overrides.markEpoch ?? 0,
  );
}

async function insertGcState(
  overrides: Partial<{
    projectId: string;
    epoch: number;
    phase: string;
    rootCursor: string | null;
    sweepCursor: Buffer | null;
  }> = {},
) {
  return db.run(
    `INSERT INTO io_cas_gc_state (project_id, epoch, phase, root_cursor, sweep_cursor)
     VALUES (?, ?, ?, ?, ?)`,
    overrides.projectId ?? "project-a",
    overrides.epoch ?? 0,
    overrides.phase ?? "idle",
    overrides.rootCursor ?? null,
    overrides.sweepCursor ?? null,
  );
}

async function insertMigrationState(
  overrides: Partial<{ projectId: string; job: string; status: string }> = {},
) {
  return db.run(
    `INSERT INTO io_cas_migration_state (project_id, job, status) VALUES (?, ?, ?)`,
    overrides.projectId ?? "project-a",
    overrides.job ?? "backfill-v1",
    overrides.status ?? "running",
  );
}

const countRows = async (sql: string, ...params: unknown[]) =>
  (await db.get(sql, ...params)) as { count: number };

describe("observation input CAS schema", () => {
  it("applies the CAS migration idempotently and records it once", async () => {
    await applyLocalMigrations(db, migrations);
    await applyLocalMigrations(db, migrations);
    // The `IF NOT EXISTS` entry point used by tests must expose the same tables (report C-8).
    await initializeTelemetrySchema(db);
    expect(await countRows("SELECT count(*) AS count FROM _perifuse_migrations")).toEqual({
      count: migrations.length,
    });
    const tables = (
      await db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    ).map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining(["io_cas_chunks", "io_cas_gc_state", "io_cas_migration_state"]),
    );
    expect(await countRows("SELECT count(*) AS count FROM io_cas_chunks")).toEqual({ count: 0 });
  });

  it("creates the new-table index during startup and no index on observations", async () => {
    expect(
      await countRows(
        "SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_io_cas_gc'",
      ),
    ).toEqual({ count: 1 });
    // Decision D-1: the 1.5GB observations index must not run in the startup
    // migration (adapter constructor applies every migration in IMMEDIATE mode).
    expect(
      await countRows(
        "SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name=?",
        IO_CAS_ROOTS_INDEX_NAME,
      ),
    ).toEqual({ count: 0 });
    expect(migrations.map((migration) => migration.sql).join("\n")).not.toContain(
      IO_CAS_ROOTS_INDEX_NAME,
    );
  });

  it("creates the observations root index only when the admin command runs it", async () => {
    await db.exec(IO_CAS_ROOTS_INDEX_SQL);
    await db.exec(IO_CAS_ROOTS_INDEX_SQL);
    expect(
      await countRows(
        "SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name=?",
        IO_CAS_ROOTS_INDEX_NAME,
      ),
    ).toEqual({ count: 1 });
    await db.exec(`INSERT INTO observations (project_id, id, input_codec)
      VALUES ('project-a', 'observation-0', 2), ('project-a', 'observation-1', 2),
             ('project-a', 'observation-2', 0)`);
    const plan = (
      await db.all(
        `EXPLAIN QUERY PLAN SELECT id FROM observations
         WHERE project_id=? AND input_codec=2 AND id>? ORDER BY id LIMIT 100`,
        "project-a",
        "observation-0",
      )
    ).map((row) => (row as { detail: string }).detail);
    expect(plan.join("\n")).toContain(IO_CAS_ROOTS_INDEX_NAME);
    await db.exec(`DROP INDEX ${IO_CAS_ROOTS_INDEX_NAME}`);
  });

  it("rejects chunk rows that break the content hash, codec, size or epoch bounds", async () => {
    await expect(insertChunk({ contentHash: Buffer.alloc(31, 1) })).rejects.toThrow(CHECK_FAILURE);
    await expect(insertChunk({ contentHash: Buffer.alloc(33, 1) })).rejects.toThrow(CHECK_FAILURE);
    await expect(insertChunk({ codec: 2 })).rejects.toThrow(CHECK_FAILURE);
    await expect(insertChunk({ codec: -1 })).rejects.toThrow(CHECK_FAILURE);
    await expect(insertChunk({ rawSize: 0 })).rejects.toThrow(CHECK_FAILURE);
    await expect(insertChunk({ rawSize: -1 })).rejects.toThrow(CHECK_FAILURE);
    await expect(insertChunk({ rawSize: 33554433 })).rejects.toThrow(CHECK_FAILURE);
    await expect(insertChunk({ markEpoch: -1 })).rejects.toThrow(CHECK_FAILURE);

    await insertChunk({ rawSize: 33554432, markEpoch: 0 });
    await insertChunk({ contentHash: hash(2), codec: 1, rawSize: 1, payload: Buffer.from([1]) });
    expect(
      await db.get(
        "SELECT codec, raw_size AS rawSize, length(payload) AS bytes FROM io_cas_chunks",
      ),
    ).toEqual({ codec: 0, rawSize: 33554432, bytes: 13 });
  });

  it("rejects invalid gc phase, epoch and sweep cursor width", async () => {
    // SQLite accepts NULL in an inline `TEXT PRIMARY KEY`; the design DDL adds NOT NULL.
    await expect(
      db.run("INSERT INTO io_cas_gc_state (project_id) VALUES (?)", null),
    ).rejects.toThrow(/NOT NULL constraint failed/i);
    await expect(insertGcState({ phase: "paused" })).rejects.toThrow(CHECK_FAILURE);
    await expect(insertGcState({ epoch: -1 })).rejects.toThrow(CHECK_FAILURE);
    await expect(insertGcState({ sweepCursor: Buffer.alloc(16, 3) })).rejects.toThrow(
      CHECK_FAILURE,
    );
    await insertGcState({ epoch: 1, phase: "mark", sweepCursor: hash(3), rootCursor: "obs-1" });
    expect(
      await db.get("SELECT epoch, phase, length(sweep_cursor) AS cursor FROM io_cas_gc_state"),
    ).toEqual({ epoch: 1, phase: "mark", cursor: 32 });
  });

  it("rejects unknown migration jobs and statuses", async () => {
    await expect(insertMigrationState({ job: "backfill-v2" })).rejects.toThrow(CHECK_FAILURE);
    await expect(insertMigrationState({ status: "stuck" })).rejects.toThrow(CHECK_FAILURE);
    await insertMigrationState({ job: "expand-v1", status: "done" });
    await insertMigrationState({ projectId: "project-b", job: "expand-v1", status: "paused" });
    expect(await countRows("SELECT count(*) AS count FROM io_cas_migration_state")).toEqual({
      count: 2,
    });
  });

  it("keeps content hashes unique per project and stores identical content per project", async () => {
    const payload = Buffer.from("shared message body");
    await insertChunk({ projectId: "project-a", contentHash: hash(9), payload });
    await expect(
      insertChunk({ projectId: "project-a", contentHash: hash(9), payload }),
    ).rejects.toThrow(UNIQUE_FAILURE);
    await insertChunk({ projectId: "project-b", contentHash: hash(9), payload });
    const rowsFor = async () =>
      await db.all(
        "SELECT project_id AS projectId, payload FROM io_cas_chunks WHERE content_hash=? ORDER BY project_id",
        hash(9),
      );
    const rows = await rowsFor();
    expect(rows.map((row) => (row as { projectId: string }).projectId)).toEqual([
      "project-a",
      "project-b",
    ]);
    expect(Buffer.from((rows[0] as { payload: Uint8Array }).payload)).toEqual(payload);
    expect(Buffer.from((rows[1] as { payload: Uint8Array }).payload)).toEqual(payload);
    // The identical content belongs to two independent rows: rewriting one project's
    // payload leaves the other project's bytes untouched.
    await db.run(
      "UPDATE io_cas_chunks SET payload=? WHERE project_id=? AND content_hash=?",
      Buffer.from("rewritten body"),
      "project-a",
      hash(9),
    );
    const rewritten = await rowsFor();
    expect(Buffer.from((rewritten[0] as { payload: Uint8Array }).payload).toString()).toBe(
      "rewritten body",
    );
    expect(Buffer.from((rewritten[1] as { payload: Uint8Array }).payload)).toEqual(payload);
  });
});
