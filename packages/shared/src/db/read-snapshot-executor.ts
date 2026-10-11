import type { Transaction } from "@tursodatabase/database";
import { createDatabaseError } from "./errors";
import type { ReadSnapshotOptions } from "./read-snapshot";

const STRIP_NON_SQL =
  /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g;
/** `WITH` 可前导的写语句关键字；其余控制词只能在语句首，由首 token 规则覆盖。 */
const WRITE_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);

function readonlyError() {
  return createDatabaseError("SQLITE_READONLY", "Read snapshot accepts read-only queries only");
}

/**
 * 顶层（括号深度 0）出现裸写关键字即判定为 `WITH ... AS (...) DELETE FROM ...`。
 * 函数调用形态（词后紧跟 `(`，如 `replace(a, b, c)`）不算写语句。
 */
function hasTopLevelWriteKeyword(text: string): boolean {
  let depth = 0;
  for (let index = 0; index < text.length; ) {
    const char = text[index]!;
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(char)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && /[A-Za-z0-9_$]/.test(text[end]!)) end += 1;
    if (depth === 0 && WRITE_KEYWORDS.has(text.slice(index, end).toUpperCase())) {
      let lookahead = end;
      while (lookahead < text.length && /\s/.test(text[lookahead]!)) lookahead += 1;
      if (text[lookahead] !== "(") return true;
    }
    index = end;
  }
  return false;
}

/**
 * 保守的查询子集：仅 SELECT/WITH，拒绝控制语句及多语句；不替代引擎 readonly。
 *
 * 判定只针对**语句位置**，不做全文关键字扫描：PRAGMA / BEGIN / COMMIT / RELEASE /
 * VACUUM / REINDEX / ANALYZE / ATTACH / CREATE … 都只能作为语句首 token（分号已被拒绝），
 * 全文匹配会把合法列名（`traces.release`）误判为控制关键字。`WITH` 是唯一例外——
 * 它可前导 INSERT/UPDATE/DELETE/REPLACE，因此单独检查顶层写关键字。
 */
export function assertSnapshotSql(sql: string): void {
  const tokens = sql.replace(STRIP_NON_SQL, " ").trim().replace(/;\s*$/, "");
  if (!/^(SELECT|WITH)\b/i.test(tokens) || /;/.test(tokens)) throw readonlyError();
  // `load_extension()` 是唯一可在 SELECT 内触发引擎副作用的函数。
  if (/\bload_extension\b/i.test(tokens)) throw readonlyError();
  if (/^WITH\b/i.test(tokens) && hasTopLevelWriteKeyword(tokens)) throw readonlyError();
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
