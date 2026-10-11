/**
 * Optional local engine: a Turso-shaped Database on top of Bun's built-in
 * `bun:sqlite`. Only the surface this project actually uses is implemented;
 * statements live in sqlite-statement.ts, ownership and retry policy in
 * sqlite-transaction.ts, and driver loading in sqlite-native.ts.
 *
 * The native handle is synchronous and `bun:sqlite` cannot share a file with
 * the Turso engine, so a Database owns exactly one connection, serialized by a
 * FIFO gate.
 */
import type { Database, Transaction } from "@tursodatabase/database";
import { createDatabaseError } from "./errors";
import {
  assertSqliteRuntime,
  BUSY_TIMEOUT_MS,
  loadBunSqlite,
  type NativeDatabase,
  readPragmaNumber,
} from "./sqlite-native";
import { type QueryOptions, SqliteStatement, type StatementOwner } from "./sqlite-statement";
import {
  assertNoTransactionReentry,
  defaultRetryClock,
  FifoGate,
  PendingOperations,
  type RetryClock,
  retryWhileBusy,
  type TransactionMode,
  transactionScope,
} from "./sqlite-transaction";

let connectionSeq = 0;
let transactionSeq = 0;
const sqliteConnections = new WeakMap<object, SqliteConnection>();

export { assertSqliteRuntime } from "./sqlite-native";

export function isSqliteDatabase(database: object): boolean {
  return sqliteConnections.has(database);
}

interface ExecutorContext {
  owner: StatementOwner;
  ready(): Promise<NativeDatabase>;
  clock: RetryClock;
}

/** Database/transaction executor: Turso's method shapes over prepared statements. */
function createExecutor(context: ExecutorContext) {
  const { owner } = context;
  const track = <T>(promise: Promise<T>): Promise<T> =>
    owner.track ? owner.track(promise) : promise;

  const prepareStatement = async (sql: string): Promise<SqliteStatement> => {
    owner.assertUsable();
    const native = await context.ready();
    const release = await owner.gate.acquire();
    try {
      owner.assertUsable();
      await owner.activate?.();
      // `prepare` (not the cached `query`) keeps exactly one statement per SQL.
      return new SqliteStatement(native.prepare(sql), owner, context.clock);
    } finally {
      release();
    }
  };

  const withStatement = async <T>(
    sql: string,
    run: (statement: SqliteStatement) => Promise<T>,
  ): Promise<T> => {
    const statement = await prepareStatement(sql);
    try {
      return await run(statement);
    } finally {
      statement.close();
    }
  };

  const runExec = async (sql: string): Promise<void> => {
    owner.assertUsable();
    const native = await context.ready();
    const release = await owner.gate.acquire();
    try {
      owner.assertUsable();
      await owner.activate?.();
      native.run(sql);
    } finally {
      release();
    }
  };

  return {
    exec(sql: string): Promise<void> {
      return track(runExec(sql));
    },
    prepare(sql: string): Promise<SqliteStatement> {
      return track(prepareStatement(sql));
    },
    run(
      sql: string,
      ...parameters: unknown[]
    ): Promise<{ changes: number; lastInsertRowid: number }> {
      return track(withStatement(sql, (statement) => statement.run(...parameters)));
    },
    get<T>(sql: string, ...parameters: unknown[]): Promise<T> {
      return track(withStatement(sql, (statement) => statement.get(...parameters))) as Promise<T>;
    },
    all<T>(sql: string, ...parameters: unknown[]): Promise<T[]> {
      return track(withStatement(sql, (statement) => statement.all(...parameters))) as Promise<T[]>;
    },
    async *iterate(sql: string, parameters?: unknown, options?: QueryOptions) {
      const statement = await prepareStatement(sql);
      try {
        yield* statement.iterate(parameters, options);
      } finally {
        statement.close();
      }
    },
  };
}

function totalChanges(native: NativeDatabase): number {
  const statement = native.prepare("SELECT total_changes() AS total");
  try {
    const row = statement.values()[0];
    return Number(row?.[0] ?? 0);
  } finally {
    statement.finalize();
  }
}

/** Transaction handle: executor plus `open`, never a nested transactionAsync. */
class TransactionContext {
  readonly registry = new PendingOperations();
  readonly owner: StatementOwner;
  readonly handle: object;
  private readonly statements = new Set<SqliteStatement>();
  private active = true;

  constructor(
    readonly id: number,
    private readonly databaseId: number,
    native: NativeDatabase,
    clock: RetryClock,
  ) {
    this.owner = {
      gate: new FifoGate(),
      assertUsable: () => {
        if (!this.active)
          throw createDatabaseError("PERIFUSE_TRANSACTION_CLOSED", "Transaction is closed");
      },
      track: (promise) => this.registry.track(promise),
      totalChanges: () => totalChanges(native),
      register: (statement) => this.statements.add(statement),
      unregister: (statement) => this.statements.delete(statement),
    };
    this.handle = {
      open: true,
      ...createExecutor({ owner: this.owner, ready: async () => native, clock }),
    };
  }

  get scope() {
    return { databaseId: this.databaseId, transactionId: this.id, active: true };
  }

  /** Stops in-flight iteration, then drains operations accepted by the callback. */
  async settle(): Promise<void> {
    for (const statement of [...this.statements]) statement.cancelIteration();
    await this.registry.drain();
    const failure = this.registry.takeFailure();
    if (failure !== undefined) throw failure;
  }

  dispose(): void {
    this.active = false;
    (this.handle as { open: boolean }).open = false;
    for (const statement of [...this.statements]) statement.close();
    this.statements.clear();
  }
}

type ConnectionState = "new" | "connecting" | "open" | "closing" | "closed" | "failed";

class SqliteConnection {
  readonly id = ++connectionSeq;
  readonly memory: boolean;
  private state: ConnectionState = "new";
  private native?: NativeDatabase;
  private failure?: Error;
  private connectPromise?: Promise<NativeDatabase>;
  private closePromise?: Promise<void>;
  private readonly gate = new FifoGate();
  private readonly statements = new Set<SqliteStatement>();
  private readonly pending = new PendingOperations();
  private walReady = false;

  constructor(
    readonly filename: string,
    readonly readonly: boolean,
    private readonly clock: RetryClock,
  ) {
    this.memory = filename === ":memory:";
  }

  createDatabase(): Database {
    const owner: StatementOwner = {
      gate: this.gate,
      assertUsable: () => {
        this.assertUsable();
        assertNoTransactionReentry(this.id);
      },
      activate: async () => {
        // Callers already hold the gate.
        const native = await this.ready();
        await this.activateWal(native);
      },
      track: (promise) => this.pending.track(promise),
      totalChanges: () => totalChanges(this.native!),
      register: (statement) => this.statements.add(statement),
      unregister: (statement) => this.statements.delete(statement),
    };
    const database = {
      ...createExecutor({ owner, ready: () => this.ready(), clock: this.clock }),
      name: this.filename,
      connect: () => this.ready().then(() => undefined),
      close: () => this.close(),
      transactionAsync: (callback: (tx: Transaction, ...args: unknown[]) => Promise<unknown>) =>
        this.transactionAsync(callback),
    };
    sqliteConnections.set(database, this);
    return database as unknown as Database;
  }

  assertUsable(): void {
    if (this.state === "closing" || this.state === "closed")
      throw createDatabaseError("PERIFUSE_SQLITE_CLOSED", "Database is closed");
    if (this.state === "failed" && this.failure) throw this.failure;
  }

  async ready(): Promise<NativeDatabase> {
    this.assertUsable();
    if (this.native) return this.native;
    this.connectPromise ??= this.connect();
    return this.connectPromise;
  }

  private async connect(): Promise<NativeDatabase> {
    this.state = "connecting";
    let handle: NativeDatabase | undefined;
    try {
      assertSqliteRuntime();
      const module = await loadBunSqlite();
      handle = new module.Database(this.filename, {
        readonly: this.readonly,
        create: !this.readonly,
        strict: false,
        safeIntegers: true,
      });
      this.native = handle;
      handle.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      handle.run("PRAGMA foreign_keys = ON");
      if (readPragmaNumber(handle, "PRAGMA foreign_keys") !== 1)
        throw createDatabaseError("PERIFUSE_SQLITE_PRAGMA", "Failed to enable foreign keys");
      if (!this.readonly) {
        handle.run("PRAGMA synchronous = FULL");
        if (!this.memory) handle.run("PRAGMA wal_autocheckpoint = 1000");
      }
      this.state = "open";
      return handle;
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.native = undefined;
      this.state = "failed";
      try {
        handle?.close(true);
      } catch {
        /* the handle never opened fully */
      }
      throw this.failure;
    }
  }

  /**
   * Activates WAL for writable files. Callers must hold the connection gate:
   * `journal_mode` cannot be changed from inside a transaction.
   */
  private async activateWal(native: NativeDatabase): Promise<void> {
    if (this.readonly || this.memory || this.walReady) return;
    // A failed activation must not stick: the next operation tries again.
    await retryWhileBusy(() => {
      const statement = native.prepare("PRAGMA journal_mode = WAL");
      let mode: unknown;
      try {
        mode = statement.values()[0]?.[0];
      } finally {
        statement.finalize();
      }
      if (String(mode).toLowerCase() !== "wal")
        throw createDatabaseError(
          "PERIFUSE_SQLITE_WAL",
          `Failed to enable the WAL journal mode (${String(mode)})`,
        );
    }, this.clock);
    this.walReady = true;
  }

  /** Hook for `ensureSqliteWal`, which is called outside the gate. */
  async activateWalHook(): Promise<void> {
    const native = await this.ready();
    const release = await this.gate.acquire();
    try {
      await this.activateWal(native);
    } finally {
      release();
    }
  }

  /** Re-applies the foreign key pragma without touching the journal mode. */
  async ensureForeignKeys(): Promise<void> {
    const native = await this.ready();
    const release = await this.gate.acquire();
    try {
      native.run("PRAGMA foreign_keys = ON");
    } finally {
      release();
    }
  }

  /** Read-only preflight used before a legacy database may be modified. */
  async inspectTables(): Promise<{ name: string }[]> {
    const native = await this.ready();
    const release = await this.gate.acquire();
    const statement = native.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    try {
      return (statement.values() as unknown[][]).map((row) => ({ name: String(row[0]) }));
    } finally {
      statement.finalize();
      release();
    }
  }

  transactionAsync(callback: (tx: Transaction, ...args: unknown[]) => Promise<unknown>) {
    if (typeof callback !== "function")
      throw new TypeError("The transaction callback must be a function");
    const execute = (mode: TransactionMode, args: unknown[]): Promise<unknown> => {
      const transaction = async (): Promise<unknown> => {
        this.assertUsable();
        assertNoTransactionReentry(this.id);
        if (this.readonly) throw createDatabaseError("SQLITE_READONLY", "Database is read-only");
        const native = await this.ready();
        const release = await this.gate.acquire();
        let context: TransactionContext | undefined;
        try {
          let begun = false;
          let failure: unknown;
          let result: unknown;
          try {
            this.assertUsable();
            await this.activateWal(native);
            await retryWhileBusy(() => native.run(`BEGIN ${mode}`), this.clock);
            begun = true;
            context = new TransactionContext(++transactionSeq, this.id, native, this.clock);
            result = await transactionScope.run(context.scope, () =>
              callback(context!.handle as unknown as Transaction, ...args),
            );
          } catch (error) {
            failure = error;
          }
          try {
            if (context) await context.settle();
          } catch (error) {
            failure ??= error;
          }
          if (failure === undefined && begun) {
            try {
              native.run("COMMIT");
            } catch (error) {
              failure = error;
            }
          }
          if (failure !== undefined) {
            this.rollback(native, begun, failure);
            throw failure;
          }
          return result;
        } finally {
          context?.dispose();
          release();
        }
      };
      return this.pending.track(transaction());
    };
    return Object.assign((...args: unknown[]) => execute("DEFERRED", args), {
      deferred: (...args: unknown[]) => execute("DEFERRED", args),
      immediate: (...args: unknown[]) => execute("IMMEDIATE", args),
      exclusive: (...args: unknown[]) => execute("EXCLUSIVE", args),
    });
  }

  /** Rolls back an open transaction; a failed rollback taints the connection. */
  private rollback(native: NativeDatabase, begun: boolean, failure: unknown): void {
    if (!begun || !native.inTransaction) return;
    try {
      native.run("ROLLBACK");
    } catch (rollbackError) {
      this.failure =
        rollbackError instanceof Error ? rollbackError : new Error("Transaction rollback failed");
      this.state = "failed";
      throw new AggregateError([failure, rollbackError], "Transaction rollback failed");
    }
  }

  async close(): Promise<void> {
    // Checked before the shared promise is created: a re-entrant close must be
    // rejected without poisoning later, legitimate closes.
    assertNoTransactionReentry(this.id);
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "new") {
      this.state = "closed";
      return;
    }
    this.state = "closing";
    await this.connectPromise?.catch(() => undefined);
    for (const statement of [...this.statements]) statement.cancelIteration();
    await this.pending.drain();
    // Wait for the queue to empty so no accepted operation is mid-flight.
    (await this.gate.acquire())();
    const native = this.native;
    this.native = undefined;
    for (const statement of [...this.statements]) statement.close();
    this.statements.clear();
    try {
      native?.close(true);
    } catch {
      /* closing an already closed handle is a no-op */
    }
    this.state = "closed";
  }
}

/**
 * Creates the sqlite-backed Database. The file is not opened here: `connect`
 * (issued lazily by every operation) loads `bun:sqlite` and opens the handle.
 */
export function createSqliteDatabase(
  filename: string,
  readonly = false,
  options: { clock?: RetryClock } = {},
): Database {
  assertSqliteRuntime();
  if (readonly && filename === ":memory:")
    throw createDatabaseError(
      "PERIFUSE_SQLITE_READONLY_MEMORY",
      "A read-only in-memory SQLite database is not supported",
    );
  return new SqliteConnection(
    filename,
    readonly,
    options.clock ?? defaultRetryClock,
  ).createDatabase();
}

/** Activates WAL on a sqlite connection; a no-op for any other engine. */
export async function ensureSqliteWal(database: object): Promise<boolean> {
  const connection = sqliteConnections.get(database);
  if (!connection) return false;
  await connection.activateWalHook();
  return true;
}

/** Re-applies foreign keys after connect without activating WAL. */
export async function initializeSqliteConnection(database: object): Promise<boolean> {
  const connection = sqliteConnections.get(database);
  if (!connection) return false;
  await connection.ensureForeignKeys();
  return true;
}

/** Read-only table listing used by the legacy preflight; undefined for other engines. */
export async function inspectSqliteTables(
  database: object,
): Promise<{ name: string }[] | undefined> {
  return sqliteConnections.get(database)?.inspectTables();
}
