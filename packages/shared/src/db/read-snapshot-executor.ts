import type { Transaction } from "@tursodatabase/database";
import { createDatabaseError } from "./errors";
import type { ReadSnapshotOptions } from "./read-snapshot";

/** 保守的查询子集：仅 SELECT/WITH，拒绝控制语句及多语句；不替代引擎 readonly。 */
export function assertSnapshotSql(sql: string): void {
  const tokens = sql
    .replace(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g,
      " ",
    )
    .trim()
    .replace(/;\s*$/, "");
  if (
    !/^(SELECT|WITH)\b/i.test(tokens) ||
    /;|\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|REINDEX|ANALYZE|load_extension)\b/i.test(
      tokens,
    )
  )
    throw createDatabaseError("SQLITE_READONLY", "Read snapshot accepts read-only queries only");
}

/** 取消先撤销句柄，再排空已接受的 SQL；绝不把活跃 SQL 留给下一位 gate owner。 */
export class SnapshotLifetime {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly statements = new Set<{ close(): void | Promise<void> }>();
  private readonly iterators = new Set<AsyncIterator<unknown>>();
  private active = true;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly abort = () => this.controller.abort();

  constructor(private readonly options: ReadSnapshotOptions) {
    if (options.timeoutMs !== undefined) {
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
        throw new RangeError("timeoutMs must be finite and non-negative");
      this.timer = setTimeout(this.abort, options.timeoutMs);
    }
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  check(): void {
    if (this.signal.aborted)
      throw createDatabaseError("PERIFUSE_READ_SNAPSHOT_CANCELLED", "Read snapshot cancelled");
    if (!this.active)
      throw createDatabaseError("PERIFUSE_TRANSACTION_CLOSED", "Read snapshot is closed");
  }

  private track<T>(work: () => Promise<T>): Promise<T> {
    const promise = (async () => {
      this.check();
      return work();
    })();
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }

  private wrapStatement<T extends object>(statement: T): T {
    return new Proxy(statement, {
      get: (target, property) => {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (["get", "all", "run"].includes(String(property)))
          return (...args: unknown[]) => this.track(() => value.apply(target, args));
        if (property === "iterate")
          return (...args: unknown[]) => this.iterate(value.apply(target, args));
        return (...args: unknown[]) => {
          this.check();
          const result = value.apply(target, args);
          return result === target ? this.wrapStatement(target) : result;
        };
      },
    });
  }

  private async *iterate(iterator: AsyncIterator<unknown>): AsyncGenerator<unknown> {
    this.iterators.add(iterator);
    try {
      for (;;) {
        const next = await this.track(() => iterator.next());
        this.check();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      this.iterators.delete(iterator);
      await iterator.return?.();
    }
  }

  private executor(tx: Transaction): Transaction {
    const call = (method: string, sql: string, args: unknown[]) => {
      this.check();
      assertSnapshotSql(sql);
      return Reflect.get(tx, method).call(tx, sql, ...args);
    };
    return {
      get open() {
        return tx.open;
      },
      get: (sql: string, ...args: unknown[]) => this.track(() => call("get", sql, args)),
      all: (sql: string, ...args: unknown[]) => this.track(() => call("all", sql, args)),
      run: (sql: string, ...args: unknown[]) => this.track(() => call("run", sql, args)),
      // exec 不执行任意 SQL 序列，统一走单条已检查的查询。
      exec: (sql: string) => this.track(async () => void (await call("all", sql, []))),
      prepare: (sql: string) =>
        this.track(async () => {
          const statement = await call("prepare", sql, []);
          this.statements.add(statement);
          return this.wrapStatement(statement);
        }),
      iterate: (sql: string, ...args: unknown[]) => {
        const self = this;
        return (async function* () {
          const statement = await self.track(async () => {
            const prepared = await call("prepare", sql, []);
            self.statements.add(prepared);
            return prepared;
          });
          yield* self.iterate(statement.iterate(...args));
        })();
      },
    } as unknown as Transaction;
  }

  async run<T>(tx: Transaction, callback: (tx: Transaction) => Promise<T>): Promise<T> {
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () =>
        reject(createDatabaseError("PERIFUSE_READ_SNAPSHOT_CANCELLED", "Read snapshot cancelled"));
    });
    this.signal.addEventListener("abort", rejectAbort, { once: true });
    try {
      this.check();
      return await Promise.race([
        Promise.resolve().then(() => {
          this.check();
          return callback(this.executor(tx));
        }),
        cancelled,
      ]);
    } finally {
      this.active = false;
      this.signal.removeEventListener("abort", rejectAbort);
      // 排空 native 调用后关闭 iterator，避免活跃 statement 阻塞 COMMIT。
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      for (const iterator of this.iterators) await iterator.return?.();
      for (const statement of this.statements) await statement.close();
    }
  }

  dispose(): void {
    this.active = false;
    clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.abort);
  }
}
