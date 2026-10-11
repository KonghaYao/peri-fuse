import { AsyncLocalStorage } from "node:async_hooks";
import type { Database, Transaction } from "@tursodatabase/database";
import { createDatabaseError } from "./errors";
import { type ReadSnapshotProvider, registerReadSnapshot } from "./read-snapshot";

const localProviders = new WeakMap<object, ReadSnapshotProvider>();

/** 仅供引擎契约验收；不能作为 CAS/GC 公共入口。 */
export function getLocalReadSnapshotProvider(db: object): ReadSnapshotProvider {
  const provider = localProviders.get(db);
  if (!provider) throw new Error("Not a registered Turso local database");
  return provider;
}

const scope = new AsyncLocalStorage<object>();

/** Turso 自带连接 gate；此代理只补父句柄重入检查，不另外创建连接。 */
export function registerLocalReadSnapshot(database: Database): Database {
  // Captured at registration: fault-injection spies wrap the value they read
  // from this proxy, so the wrapper must always reach the driver method it was
  // created for. Reading `database.transactionAsync` late would target the spy
  // instead and recurse between mock and wrapper.
  const nativeTransactionAsync = database.transactionAsync.bind(database);
  const nativeTransactionAsyncValue = database.transactionAsync;
  const assertNotParent = () => {
    if (scope.getStore() === database)
      throw createDatabaseError("PERIFUSE_TRANSACTION_REENTRY", "Use the transaction handle");
  };
  const transaction = <T>(callback: (tx: Transaction, ...args: unknown[]) => Promise<T>) => {
    const execute = (mode: "deferred" | "immediate" | "exclusive", args: unknown[]) => {
      assertNotParent();
      return nativeTransactionAsync((tx, ...values: unknown[]) =>
        scope.run(database, () => callback(tx, ...values)),
      )[mode](...args);
    };
    return Object.assign((...args: unknown[]) => execute("deferred", args), {
      deferred: (...args: unknown[]) => execute("deferred", args),
      immediate: (...args: unknown[]) => execute("immediate", args),
      exclusive: (...args: unknown[]) => execute("exclusive", args),
    });
  };
  const wrapper = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property);
      // Only the untouched driver method maps to the reentry-aware wrapper;
      // once a spy replaced it, callers keep going through that spy.
      if (property === "transactionAsync")
        return value === nativeTransactionAsyncValue ? transaction : value;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          assertNotParent();
        } catch (error) {
          // Turso 形状：公共方法失败走 promise 拒绝，不向 await 调用方同步抛出。
          return Promise.reject(error);
        }
        return value.apply(target, args);
      };
    },
  });
  const provider: ReadSnapshotProvider = {
    engine: "turso",
    // 0.8.2 multiprocess_wal 实测忽略 readonly；隔离通过不等于完整能力通过。
    supported: false,
    run: (callback, signal) =>
      transaction(async (tx) => {
        if (signal.aborted)
          throw createDatabaseError("PERIFUSE_READ_SNAPSHOT_CANCELLED", "Read snapshot cancelled");
        return callback(tx);
      }).deferred(),
  };
  localProviders.set(wrapper, provider);
  registerReadSnapshot(wrapper, provider);
  return wrapper;
}
