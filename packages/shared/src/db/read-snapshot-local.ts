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
  const assertNotParent = () => {
    if (scope.getStore() === database)
      throw createDatabaseError("PERIFUSE_TRANSACTION_REENTRY", "Use the transaction handle");
  };
  const transaction = <T>(callback: (tx: Transaction, ...args: unknown[]) => Promise<T>) => {
    const execute = (mode: "deferred" | "immediate" | "exclusive", args: unknown[]) => {
      assertNotParent();
      return database
        .transactionAsync((tx, ...values: unknown[]) =>
          scope.run(database, () => callback(tx, ...values)),
        )
        [mode](...args);
    };
    return Object.assign((...args: unknown[]) => execute("deferred", args), {
      deferred: (...args: unknown[]) => execute("deferred", args),
      immediate: (...args: unknown[]) => execute("immediate", args),
      exclusive: (...args: unknown[]) => execute("exclusive", args),
    });
  };
  const wrapper = new Proxy(database, {
    get(target, property) {
      if (property === "transactionAsync") return transaction;
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        assertNotParent();
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
