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
import { startQueryStatisticsMaintenance } from "../../db/query-statistics";
import { getSharedCasPrepareCache } from "../io-cas/prepare";
import { logger } from "../logger";
import { readObservationMetric } from "./ingestion-metrics";
import { selectVersionedColumns } from "./ingestion-versions";
import {
  type CasWriteConfig,
  type PreparedIoColumns,
  prepareIoColumns,
  publishIoColumnsIfWinner,
  resolveCasWriteConfig,
} from "./io-columns-decision";
import { ioColumns } from "./io-compression";
import { readTelemetryRows } from "./io-read";
import {
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_MAX_RESULT_ROWS,
  isReadOnlySql,
  resolveReadPoolSize,
  SqliteReadPool,
} from "./sqlite-read-pool";
import { readTelemetryMigrations } from "./sqlite-telemetry-schema";
import {
  createMutationContext,
  executeTelemetryCommand,
  flushIngestionMetrics,
  isTelemetryEntity,
  type MetricsToRefresh,
  mutationSnapshotColumns,
  recordTelemetryMutation,
} from "./telemetry-mutations";
import { currentTelemetryQuerySignal, recordTelemetryQueryError } from "./telemetry-query-context";
import { withTransactionStatementCache } from "./tx-statement-cache";
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
  private readonly casWrite: CasWriteConfig;
  private readPool: SqliteReadPool | null = null;
  private readPoolInit = false;
  private stopStatisticsMaintenance: (() => void) | null = null;
  private closed = false;

  constructor(dbPath?: string) {
    const compression = process.env.PERIFUSE_IO_COMPRESSION_WRITE;
    if (compression !== undefined && compression !== "off" && compression !== "on")
      throw new Error("IO_COMPRESSION_INVALID_CONFIG");
    this.compressIo = compression === "on";
    this.casWrite = resolveCasWriteConfig();
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
    void this.ready
      .then(() => {
        if (this.closed) return;
        this.stopStatisticsMaintenance = startQueryStatisticsMaintenance(this.db, {
          onEvent: (event) => {
            if (event.type === "analyzed")
              logger.info("[SQLiteTelemetryAdapter] Query statistics analyzed", {
                tables: event.tables,
              });
            else
              logger.warn("[SQLiteTelemetryAdapter] Query statistics maintenance failed", {
                reason: event.message,
              });
          },
        });
      })
      .catch(() => undefined);
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
      const maxRows = Math.min(
        opts.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS,
        DEFAULT_MAX_RESULT_ROWS,
      );
      const maxBytes = Math.min(
        opts.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
        DEFAULT_MAX_RESULT_BYTES,
      );
      // 正文读取（ioRead=auto）在 DECODE 前于同一读快照内 hydrate；NO-GO 引擎被守卫拒绝。
      const rows = await readTelemetryRows(this.db, opts, { maxRows, maxBytes, deadline });
      return rows as T[];
    } catch (error) {
      recordTelemetryQueryError(error);
      logger.error("[SQLiteTelemetryAdapter] Query failed", error);
      throw error;
    }
  }

  async command(opts: TelemetryQueryOpts): Promise<{ changes: number }> {
    await this.initialize();
    return this.db
      .transactionAsync(async (tx) =>
        withTransactionStatementCache(tx, async (cachedTx) => {
          const pending: MetricsToRefresh = createMutationContext();
          const result = await executeTelemetryCommand(cachedTx, opts, pending);
          await flushIngestionMetrics(cachedTx, pending);
          return result;
        }),
      )
      .immediate();
  }

  async commandBatch(commands: TelemetryQueryOpts[], guard?: TelemetryQueryOpts): Promise<boolean> {
    await this.initialize();
    return this.db
      .transactionAsync(async (tx) =>
        withTransactionStatementCache(tx, async (cachedTx) => {
          if (guard && !(await cachedTx.get(guard.query, guard.params ?? {}))) return false;
          const pending: MetricsToRefresh = createMutationContext();
          for (const opts of commands) await executeTelemetryCommand(cachedTx, opts, pending);
          await flushIngestionMetrics(cachedTx, pending);
          return true;
        }),
      )
      .immediate();
  }

  /**
   * W5 ①：纯准备（IO 三列编码 + CAS 切片/hash/manifest/池块）在写锁之前完成；
   * 单次调用失败不会留下半发布状态（发布在事务内，见 `publishIoColumnsIfWinner`）。
   * D-8：CAS 开启时复用进程内单例缓存（≤32MiB、按项目键控，命中后仍查池）。
   */
  private prepareRows<T>(table: string, records: T[]): PreparedIoColumns[] {
    const cache = this.casWrite.enabled ? getSharedCasPrepareCache() : undefined;
    return records.map((record) =>
      prepareIoColumns(table, record as Record<string, unknown>, {
        compress: this.compressIo,
        cas: this.casWrite,
        cache,
      }),
    );
  }

  async insert<T = Record<string, unknown>>(opts: TelemetryInsertOpts<T>): Promise<void> {
    if (!opts.records.length) return;
    await this.initialize();
    const prepared = this.prepareRows(opts.table, opts.records);
    await this.db
      .transactionAsync(async (tx) =>
        withTransactionStatementCache(tx, async (cachedTx) => {
          const pending: MetricsToRefresh = createMutationContext();
          for (const [index, record] of opts.records.entries()) {
            const row = record as Record<string, unknown>;
            const encoded = prepared[index].encoded;
            const columns = Object.keys(encoded);
            const requested = opts.updateColumns?.[index].filter((column) =>
              columns.includes(column),
            );
            const decision =
              requested && opts.eventIds
                ? await selectVersionedColumns(
                    cachedTx,
                    opts.table,
                    row,
                    requested,
                    opts.eventIds[index],
                    opts.inheritColumns?.[index],
                    isTelemetryEntity(opts.table) ? mutationSnapshotColumns(opts.table) : "id",
                  )
                : undefined;
            if (decision && !decision.entityChanged) continue;
            const before = decision
              ? decision.before
              : isTelemetryEntity(opts.table)
                ? await cachedTx.get(
                    `SELECT ${mutationSnapshotColumns(opts.table)} FROM ${opts.table} WHERE project_id=? AND id=?`,
                    row.project_id,
                    row.id,
                  )
                : undefined;
            const beforeMetric =
              opts.table === "observations" && before && typeof before.trace_id === "string"
                ? await readObservationMetric(
                    cachedTx,
                    String(before.project_id),
                    before.trace_id,
                    String(before.id),
                  )
                : undefined;
            let conflict = "";
            let searchColumns: string[] = [];
            // SQL CASE 分支在 `!opts.eventIds && !requested.includes(column)` 时可能写入 input。
            const inheritInput =
              requested !== undefined &&
              !opts.eventIds &&
              !requested.includes("input") &&
              Boolean(opts.inheritColumns?.[index]?.includes("input"));
            if (requested) {
              const updates = decision?.acceptedColumns ?? requested;
              searchColumns = [...updates];
              const clauses = [
                ...new Set(updates.flatMap((column) => ioColumns(opts.table, column))),
              ].map((column) => `${column}=excluded.${column}`);
              for (const column of opts.inheritColumns?.[index] ?? []) {
                if (
                  !opts.eventIds &&
                  !requested.includes(column) &&
                  (column === "input" || column === "output")
                ) {
                  searchColumns.push(column);
                  for (const companion of ioColumns(opts.table, column))
                    clauses.push(
                      `${companion}=CASE WHEN ${opts.table}.${column}_codec=0 AND ${opts.table}.${column} IS NULL THEN excluded.${companion} ELSE ${opts.table}.${companion} END`,
                    );
                }
              }
              conflict = ` ON CONFLICT(project_id,id) DO ${clauses.length ? `UPDATE SET ${clauses.join(",")}` : "NOTHING"}`;
            }
            // W5 ③：只有 input 在这一行的版本决策中胜出才发布 CAS（池内容 + 写屏障）。
            // 发布先于行写入、与行写入同事务；未胜出时对池 0 次查询（见 io-columns-decision）。
            await publishIoColumnsIfWinner(cachedTx, {
              mode: "insert",
              table: opts.table,
              rowId: String(row.id),
              projectId: String(row.project_id),
              prepared: prepared[index],
              requested,
              accepted: decision?.acceptedColumns,
              rowExists: before !== undefined,
              inheritInput,
            });
            const result = await cachedTx.run(
              `INSERT ${opts.updateColumns ? "" : "OR REPLACE "}INTO ${opts.table} (${columns.join(",")}) VALUES (${columns.map((column) => `@${column}`).join(",")})${conflict}`,
              encoded,
            );
            if (!Number(result.changes)) continue;
            const after = isTelemetryEntity(opts.table)
              ? await cachedTx.get(
                  `SELECT ${mutationSnapshotColumns(opts.table)} FROM ${opts.table} WHERE project_id=? AND id=?`,
                  row.project_id,
                  row.id,
                )
              : undefined;
            const searchChanged =
              !before ||
              !after ||
              ["input", "output"].some((column) => searchColumns.includes(column)) ||
              ["trace_id", "type", "timestamp", "start_time", "is_deleted"].some(
                (column) => before[column] !== after[column],
              ) ||
              !opts.updateColumns;
            await recordTelemetryMutation(
              cachedTx,
              opts.table,
              before,
              after,
              pending,
              searchChanged,
              beforeMetric,
            );
          }
          await flushIngestionMetrics(cachedTx, pending);
        }),
      )
      .immediate();
  }

  async mergeInsert<T = Record<string, unknown>>(opts: TelemetryInsertOpts<T>): Promise<void> {
    if (!opts.records.length) return;
    await this.initialize();
    const prepared = this.prepareRows(opts.table, opts.records);
    await this.db
      .transactionAsync(async (tx) =>
        withTransactionStatementCache(tx, async (cachedTx) => {
          const pending: MetricsToRefresh = createMutationContext();
          for (const [index, record] of opts.records.entries()) {
            const row = record as Record<string, unknown>;
            const encoded = prepared[index].encoded;
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
              ? await cachedTx.get(
                  `SELECT ${mutationSnapshotColumns(opts.table)} FROM ${opts.table} WHERE project_id=? AND id=?`,
                  row.project_id,
                  row.id,
                )
              : undefined;
            const beforeMetric =
              opts.table === "observations" && before && typeof before.trace_id === "string"
                ? await readObservationMetric(
                    cachedTx,
                    String(before.project_id),
                    before.trace_id,
                    String(before.id),
                  )
                : undefined;
            // W5 ③：merge 的 `excluded.input IS NOT NULL` 分支必然写入候选 manifest，胜出即发布。
            await publishIoColumnsIfWinner(cachedTx, {
              mode: "merge",
              table: opts.table,
              rowId: String(row.id),
              projectId: String(row.project_id),
              prepared: prepared[index],
              rowExists: before !== undefined,
              inheritInput: false,
            });
            const result = await cachedTx.run(
              `INSERT INTO ${opts.table} (${columns.join(",")}) VALUES (${columns.map((column) => `@${column}`).join(",")}) ON CONFLICT(${keys.join(",")}) DO ${clauses.length ? `UPDATE SET ${clauses.join(",")}` : "NOTHING"}`,
              encoded,
            );
            if (!Number(result.changes)) continue;
            const after = isTelemetryEntity(opts.table)
              ? await cachedTx.get(
                  `SELECT ${mutationSnapshotColumns(opts.table)} FROM ${opts.table} WHERE project_id=? AND id=?`,
                  row.project_id,
                  row.id,
                )
              : undefined;
            const searchChanged =
              !before ||
              !after ||
              ["input", "output"].some((column) => columns.includes(column)) ||
              ["trace_id", "type", "timestamp", "start_time", "is_deleted"].some(
                (column) => before[column] !== after[column],
              );
            await recordTelemetryMutation(
              cachedTx,
              opts.table,
              before,
              after,
              pending,
              searchChanged,
              beforeMetric,
            );
          }
          await flushIngestionMetrics(cachedTx, pending);
        }),
      )
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
    this.stopStatisticsMaintenance?.();
    this.stopStatisticsMaintenance = null;
    await this.ready.catch(() => undefined);
    await this.readPool?.close();
    await this.db.close();
  }
}
