import type { LocalExecutor } from "../../db/local";

/**
 * Statement reuse inside one transaction callback.
 *
 * The driver re-prepares the SQL for every `run`/`get`/`all` call and finalizes
 * the statement right afterwards (Turso `Transaction.run` →
 * `prepare` → `Statement.run` → `close`; the `bun:sqlite` compatibility engine
 * does the same through `withStatement`). This cache removes that compile step
 * for repeated calls with the same SQL text, and nothing else: the SQL text,
 * the number of statement executions, the bindings and the transaction
 * boundaries are unchanged.
 *
 * Two driver-level facts shape the design:
 *
 * 1. Statements keep binding memory between executions. Turso's `bindParams`
 *    only writes the parameters that are present and defined, and the
 *    `bun:sqlite` layer does the same for named keys and positional slots
 *    (`docs/sqlite-engine.md` records "未提供参数可以保留已有绑定"). Reusing a
 *    statement for a call that leaves a parameter out would therefore surface
 *    the *previous* value instead of `NULL`, and mixing named and positional
 *    calls on one statement throws in the compatibility layer. The cache entry
 *    records the binding shape of the call that created it and falls back to
 *    the driver path whenever a later call does not match exactly
 *    (`bindingShape`), so a cached statement is only ever rebound with values
 *    that overwrite every slot it uses. That is also why the binding style is
 *    not part of the key: a mismatching call must not use the statement at all,
 *    not use a second one.
 * 2. Statements belong to the transaction that prepared them. Turso statements
 *    prepared from a `Transaction` never re-acquire the database lock (no
 *    self-deadlock) but become unusable once the transaction completes.
 *    Cached statements are therefore closed before the callback returns —
 *    including the error path — and never survive into the next transaction
 *    attempt (`retryWhileBusy` re-runs the whole callback and builds a new
 *    cache).
 */

/** Hard cap: dynamic UPSERT column sets would otherwise create unbounded statement shapes. */
const DEFAULT_MAX_STATEMENTS = 64;

type PreparedStatement = {
  run(...parameters: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
  get(...parameters: unknown[]): Promise<unknown>;
  all(...parameters: unknown[]): Promise<unknown[]>;
  close?: () => unknown;
};

type StatementMethod = "run" | "get" | "all";

type CacheEntry = {
  statement: PreparedStatement;
  /** Binding shape of every call allowed to reuse this statement. */
  shape: string;
  /** Calls currently executing this statement; such an entry is never evicted. */
  active: number;
};

function isPreparedStatement(value: unknown): value is PreparedStatement {
  if (value === null || typeof value !== "object") return false;
  const statement = value as Record<string, unknown>;
  return (
    typeof statement.run === "function" &&
    typeof statement.get === "function" &&
    typeof statement.all === "function"
  );
}

function hasClose(value: unknown): value is { close: () => unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { close?: unknown }).close === "function"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Mirrors the driver's `splitBindParameters`: a trailing query-options object is not a binding. */
function isQueryOptions(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "queryTimeout")
  );
}

function bindingArguments(parameters: unknown[]): unknown[] {
  if (parameters.length > 1 && isQueryOptions(parameters[parameters.length - 1]))
    return parameters.length === 2 ? [parameters[0]] : parameters.slice(0, -1);
  return parameters;
}

/**
 * Comparable description of a binding call, or `undefined` when the call must
 * not touch a cached statement. `undefined` values and array arguments are the
 * two inputs that leave parts of a statement's binding memory from an earlier
 * call in place, so those calls always prepare a fresh statement instead; an
 * object left in a positional call is rejected by both drivers, so it stays on
 * the driver path too.
 */
function bindingShape(parameters: unknown[]): string | undefined {
  if (parameters.some((value) => Array.isArray(value))) return undefined;
  const bound = bindingArguments(parameters);
  if (bound.length === 1 && isPlainObject(bound[0])) {
    const named = bound[0];
    const keys = Object.keys(named);
    if (keys.some((key) => named[key] === undefined)) return undefined;
    return `named:${[...keys].sort().join("\u0000")}`;
  }
  if (bound.some((value) => value === undefined || isPlainObject(value))) return undefined;
  return `positional:${bound.length}`;
}

export class TransactionStatementCache {
  private readonly statements = new Map<string, CacheEntry>();
  private readonly prepare: ((sql: string) => unknown) | null;
  private readonly limit: number;
  private disabled = false;

  constructor(executor: LocalExecutor, limit = DEFAULT_MAX_STATEMENTS) {
    this.limit = Math.max(1, Math.trunc(limit) || 1);
    const candidate = executor as unknown as { prepare?: unknown };
    // Statements must come from this executor: a statement prepared on the
    // outer Database would queue behind the transaction's own lock and wait on
    // itself. Preparing is allowed to be missing or to fail — the cache then
    // stays disabled and every call uses the driver path.
    this.prepare =
      typeof candidate.prepare === "function"
        ? (candidate.prepare as (sql: string) => unknown).bind(executor)
        : null;
    if (!this.prepare) this.disabled = true;
  }

  /** Number of statements currently held; bounded by the constructor limit. */
  get size(): number {
    return this.statements.size;
  }

  async run(
    sql: string,
    parameters: unknown[],
    fallback: () => Promise<{ changes: number; lastInsertRowid: number }>,
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    return this.execute("run", sql, parameters, fallback);
  }

  async get<T>(sql: string, parameters: unknown[], fallback: () => Promise<T>): Promise<T> {
    return this.execute("get", sql, parameters, fallback);
  }

  async all<T>(sql: string, parameters: unknown[], fallback: () => Promise<T[]>): Promise<T[]> {
    return this.execute("all", sql, parameters, fallback);
  }

  /** Finalizes every cached statement; must run before the transaction commits. */
  async close(): Promise<void> {
    const entries = [...this.statements.values()];
    this.statements.clear();
    for (const entry of entries) await this.closeStatement(entry.statement);
  }

  private async execute<T>(
    method: StatementMethod,
    sql: string,
    parameters: unknown[],
    fallback: () => Promise<T>,
  ): Promise<T> {
    const shape = bindingShape(parameters);
    if (shape === undefined) return fallback();
    const entry = await this.acquire(sql, shape);
    if (!entry) return fallback();
    entry.active += 1;
    try {
      if (method === "run") return (await entry.statement.run(...parameters)) as T;
      if (method === "get") return (await entry.statement.get(...parameters)) as T;
      return (await entry.statement.all(...parameters)) as T;
    } finally {
      entry.active -= 1;
    }
  }

  private async acquire(sql: string, shape: string): Promise<CacheEntry | undefined> {
    if (this.disabled || !this.prepare) return undefined;
    const cached = this.statements.get(sql);
    if (cached) {
      // A different shape would keep the bindings this call does not overwrite.
      if (cached.shape !== shape) return undefined;
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    let prepared: unknown;
    try {
      prepared = await this.prepare(sql);
    } catch {
      // From here on the cache behaves exactly like the uncached driver path.
      this.disabled = true;
      return undefined;
    }
    if (!isPreparedStatement(prepared)) {
      this.disabled = true;
      if (hasClose(prepared)) await this.closeStatement(prepared);
      return undefined;
    }
    const entry: CacheEntry = { statement: prepared, shape, active: 0 };
    this.statements.set(sql, entry);
    await this.evict();
    return entry;
  }

  /** Least-recently-used eviction: hits move their entry to the back of the map. */
  private async evict(): Promise<void> {
    while (this.statements.size > this.limit) {
      let oldest: [string, CacheEntry] | undefined;
      for (const candidate of this.statements) {
        if (candidate[1].active === 0) {
          oldest = candidate;
          break;
        }
      }
      // Every entry is mid-flight: the cap can only be exceeded by the number
      // of statements executing right now, never without bound.
      if (!oldest) return;
      this.statements.delete(oldest[0]);
      await this.closeStatement(oldest[1].statement);
    }
  }

  private async closeStatement(statement: PreparedStatement | { close: () => unknown }) {
    try {
      await statement.close?.();
    } catch {
      // Statement cleanup must not change the transaction result.
    }
  }
}

/**
 * Runs `callback` with a statement cache bound to `executor` (a transaction
 * handle). The handle is wrapped so that `run`/`get`/`all` reuse prepared
 * statements; every other member is forwarded untouched, so callers that hand
 * the executor on (repositories, session search storage, command helpers) keep
 * working without changes.
 */
export async function withTransactionStatementCache<T>(
  executor: LocalExecutor,
  callback: (cachedExecutor: LocalExecutor) => Promise<T>,
): Promise<T> {
  const cache = new TransactionStatementCache(executor);
  const cachedExecutor = new Proxy(executor, {
    get(target, property) {
      // No receiver: accessors must keep running against the real handle.
      if (property !== "run" && property !== "get" && property !== "all")
        return Reflect.get(target, property);
      const method = Reflect.get(target, property);
      if (typeof method !== "function") return method;
      const call = (method as (...args: unknown[]) => unknown).bind(target);
      return (sql: string, ...parameters: unknown[]) => {
        const fallback = () => Promise.resolve(call(sql, ...parameters));
        if (property === "run") return cache.run(sql, parameters, fallback);
        if (property === "get") return cache.get(sql, parameters, fallback);
        return cache.all(sql, parameters, fallback);
      };
    },
  }) as LocalExecutor;
  try {
    return await callback(cachedExecutor);
  } finally {
    // Statements are scoped to the transaction: release them before it commits.
    await cache.close();
  }
}
