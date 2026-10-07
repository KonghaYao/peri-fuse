import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyLocalMigrations,
  createLocalDatabase,
  isRemoteDatabaseUrl,
  type LocalDatabase,
  resolveDatabaseConfig,
  resolveLocalPath,
  validateDatabaseConfig,
} from "../../db/local";
import { logger } from "../logger";
import { selectVersionedColumns } from "./ingestion-versions";
import { decodeIoRow, encodeIoRow, ioColumns } from "./io-compression";
import {
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_MAX_RESULT_ROWS,
  isReadOnlySql,
  resolveReadPoolSize,
  SqliteReadPool,
} from "./sqlite-read-pool";
import { readTelemetryMigrations } from "./sqlite-telemetry-schema";
import {
  executeTelemetryCommand,
  isTelemetryEntity,
  recordTelemetryMutation,
} from "./telemetry-mutations";
import {
  currentTelemetryQuerySignal,
  recordTelemetryQueryError,
  TelemetryQueryError,
} from "./telemetry-query-context";
import type { TelemetryDBAdapter, TelemetryInsertOpts, TelemetryQueryOpts } from "./types";

export {
  TRACE_METRICS_CACHE_CREATION_TOKENS_SQL,
  TRACE_METRICS_CACHED_TOKENS_SQL,
  TRACE_METRICS_GROSS_INPUT_TOKENS_SQL,
} from "./trace-metrics-sql";

function findMonorepoRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 10; depth++) {
    if (fs.existsSync(path.join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return process.cwd();
}

export class SQLiteTelemetryAdapter implements TelemetryDBAdapter {
  private readonly db: LocalDatabase;
  private readonly ready: Promise<void>;
  private readonly dbPath: string;
  private readonly authToken?: string;
  private readonly compressIo: boolean;
  private readPool: SqliteReadPool | null = null;
  private readPoolInit = false;
  private closed = false;

  constructor(dbPath?: string) {
    const compression = process.env.PERIFUSE_IO_COMPRESSION_WRITE;
    if (compression !== undefined && compression !== "off" && compression !== "on")
      throw new Error("IO_COMPRESSION_INVALID_CONFIG");
    this.compressIo = compression === "on";
    const config =
      dbPath === undefined
        ? resolveDatabaseConfig("telemetry", ".langfuse/telemetry.turso.db")
        : validateDatabaseConfig({
            url: dbPath,
            authToken: process.env.TURSO_TELEMETRY_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN,
          });
    this.dbPath = isRemoteDatabaseUrl(config.url)
      ? config.url
      : resolveLocalPath(config.url, findMonorepoRoot());
    this.authToken = config.authToken;
    this.db = createLocalDatabase(this.dbPath, false, this.authToken);
    this.ready = applyLocalMigrations(this.db, readTelemetryMigrations());
    void this.ready.catch(() => undefined);
  }

  async initialize(): Promise<void> {
    if (this.closed) throw new Error("Telemetry database is closed");
    await this.ready;
  }

  private getReadPool(): SqliteReadPool | null {
    if (!this.readPoolInit) {
      this.readPoolInit = true;
      const size = this.dbPath === ":memory:" ? 0 : resolveReadPoolSize();
      if (size > 0) this.readPool = new SqliteReadPool(this.dbPath, size, {}, this.authToken);
    }
    return this.readPool;
  }

  async query<T = Record<string, unknown>>(opts: TelemetryQueryOpts): Promise<T[]> {
    await this.initialize();
    opts = { ...opts, signal: opts.signal ?? currentTelemetryQuerySignal() };
    opts.signal?.throwIfAborted();
    for (const limit of [opts.timeoutMs, opts.maxResultRows, opts.maxResultBytes]) {
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0))
        throw new Error("Invalid telemetry query limit");
    }
    try {
      if (isReadOnlySql(opts.query)) {
        const pool = this.getReadPool();
        if (pool) return await pool.query<T>(opts.query, opts.params ?? {}, opts);
      }
      const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
      const rows: T[] = [];
      let bytes = 0;
      const maxRows = Math.min(
        opts.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS,
        DEFAULT_MAX_RESULT_ROWS,
      );
      const maxBytes = Math.min(
        opts.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
        DEFAULT_MAX_RESULT_BYTES,
      );
      for await (const source of this.db.iterate(opts.query, opts.params ?? {}, {
        queryTimeout: opts.timeoutMs ?? 30_000,
      })) {
        opts.signal?.throwIfAborted();
        if (Date.now() >= deadline)
          throw new TelemetryQueryError("TIMEOUT", "Telemetry query timed out");
        const row = decodeIoRow(source);
        bytes += 64;
        for (const [key, value] of Object.entries(row)) {
          bytes +=
            key.length * 2 +
            32 +
            (typeof value === "string"
              ? value.length * 2
              : value instanceof Uint8Array
                ? value.byteLength
                : 8);
        }
        if (rows.length >= maxRows || bytes > maxBytes)
          throw new TelemetryQueryError(
            "RESULT_LIMIT",
            "Telemetry query result limit exceeded; paginate or narrow the query",
          );
        rows.push(row as T);
      }
      return rows;
    } catch (error) {
      recordTelemetryQueryError(error);
      logger.error("[SQLiteTelemetryAdapter] Query failed", error);
      throw error;
    }
  }

  async command(opts: TelemetryQueryOpts): Promise<{ changes: number }> {
    await this.initialize();
    return this.db.transactionAsync((tx) => executeTelemetryCommand(tx, opts)).immediate();
  }

  async commandBatch(commands: TelemetryQueryOpts[], guard?: TelemetryQueryOpts): Promise<boolean> {
    await this.initialize();
    return this.db
      .transactionAsync(async (tx) => {
        if (guard && !(await tx.get(guard.query, guard.params ?? {}))) return false;
        for (const opts of commands) await executeTelemetryCommand(tx, opts);
        return true;
      })
      .immediate();
  }

  async insert<T = Record<string, unknown>>(opts: TelemetryInsertOpts<T>): Promise<void> {
    if (!opts.records.length) return;
    await this.initialize();
    await this.db
      .transactionAsync(async (tx) => {
        for (const [index, record] of opts.records.entries()) {
          const row = record as Record<string, unknown>;
          const encoded = encodeIoRow(opts.table, row, this.compressIo);
          const columns = Object.keys(encoded);
          const before = isTelemetryEntity(opts.table)
            ? await tx.get(
                `SELECT * FROM ${opts.table} WHERE project_id=? AND id=?`,
                row.project_id,
                row.id,
              )
            : undefined;
          let conflict = "";
          if (opts.updateColumns) {
            const requested = opts.updateColumns[index].filter((column) =>
              columns.includes(column),
            );
            const updates = opts.eventIds
              ? await selectVersionedColumns(
                  tx,
                  opts.table,
                  row,
                  requested,
                  opts.eventIds[index],
                  opts.inheritColumns?.[index],
                )
              : requested;
            const clauses = [
              ...new Set(updates.flatMap((column) => ioColumns(opts.table, column))),
            ].map((column) => `${column}=excluded.${column}`);
            for (const column of opts.inheritColumns?.[index] ?? []) {
              if (
                !opts.eventIds &&
                !requested.includes(column) &&
                (column === "input" || column === "output")
              ) {
                for (const companion of ioColumns(opts.table, column))
                  clauses.push(
                    `${companion}=CASE WHEN ${opts.table}.${column}_codec=0 AND ${opts.table}.${column} IS NULL THEN excluded.${companion} ELSE ${opts.table}.${companion} END`,
                  );
              }
            }
            conflict = ` ON CONFLICT(project_id,id) DO ${clauses.length ? `UPDATE SET ${clauses.join(",")}` : "NOTHING"}`;
          }
          await tx.run(
            `INSERT ${opts.updateColumns ? "" : "OR REPLACE "}INTO ${opts.table} (${columns.join(",")}) VALUES (${columns.map((column) => `@${column}`).join(",")})${conflict}`,
            encoded,
          );
          const after = isTelemetryEntity(opts.table)
            ? await tx.get(
                `SELECT * FROM ${opts.table} WHERE project_id=? AND id=?`,
                row.project_id,
                row.id,
              )
            : undefined;
          await recordTelemetryMutation(tx, opts.table, before, after);
        }
      })
      .immediate();
  }

  async mergeInsert<T = Record<string, unknown>>(opts: TelemetryInsertOpts<T>): Promise<void> {
    if (!opts.records.length) return;
    await this.initialize();
    await this.db
      .transactionAsync(async (tx) => {
        for (const record of opts.records) {
          const row = record as Record<string, unknown>;
          const encoded = encodeIoRow(opts.table, row, this.compressIo);
          const columns = Object.keys(encoded);
          const keys =
            isTelemetryEntity(opts.table) || opts.table === "dataset_run_items"
              ? ["project_id", "id"]
              : ["id"];
          const clauses = Object.keys(row)
            .filter((column) => !keys.includes(column))
            .flatMap((column) =>
              ioColumns(opts.table, column).map(
                (companion) =>
                  `${companion}=CASE WHEN excluded.${column} IS NOT NULL THEN excluded.${companion} ELSE ${opts.table}.${companion} END`,
              ),
            );
          const before = isTelemetryEntity(opts.table)
            ? await tx.get(
                `SELECT * FROM ${opts.table} WHERE project_id=? AND id=?`,
                row.project_id,
                row.id,
              )
            : undefined;
          await tx.run(
            `INSERT INTO ${opts.table} (${columns.join(",")}) VALUES (${columns.map((column) => `@${column}`).join(",")}) ON CONFLICT(${keys.join(",")}) DO ${clauses.length ? `UPDATE SET ${clauses.join(",")}` : "NOTHING"}`,
            encoded,
          );
          const after = isTelemetryEntity(opts.table)
            ? await tx.get(
                `SELECT * FROM ${opts.table} WHERE project_id=? AND id=?`,
                row.project_id,
                row.id,
              )
            : undefined;
          await recordTelemetryMutation(tx, opts.table, before, after);
        }
      })
      .immediate();
  }

  async queryDatasetRunItems(
    projectId: string,
    datasetRunId?: string,
  ): Promise<Record<string, unknown>[]> {
    return this.query({
      query: `SELECT * FROM dataset_run_items WHERE project_id=@projectId AND is_deleted=0 ${datasetRunId ? "AND dataset_run_id=@datasetRunId" : ""} ORDER BY created_at`,
      params: { projectId, datasetRunId },
    });
  }

  async *queryStream<T = Record<string, unknown>>(opts: TelemetryQueryOpts): AsyncGenerator<T> {
    for (const row of await this.query<T>(opts)) yield row;
  }

  getReadPoolStats() {
    return this.readPool?.stats() ?? null;
  }
  getDatabase(): LocalDatabase {
    return this.db;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.initialize();
      await this.db.get("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.ready.catch(() => undefined);
    await this.readPool?.close();
    await this.db.close();
  }
}
