import type { Transaction } from "@tursodatabase/database";
import { createDatabaseError } from "./errors";
import type { NativeDatabase } from "./sqlite-native";
import {
  assertNoTransactionReentry,
  type FifoGate,
  type PendingOperations,
  type RetryClock,
  retryWhileBusy,
  type TransactionMode,
  type TransactionScope,
  transactionScope,
} from "./sqlite-transaction";

interface Context {
  handle: object;
  scope: TransactionScope;
  settle(): Promise<void>;
  dispose(): void;
}

export interface SqliteTransactionHost {
  id: number;
  readonly: boolean;
  gate: FifoGate;
  pending: PendingOperations;
  clock: RetryClock;
  assertUsable(): void;
  ready(): Promise<NativeDatabase>;
  activateWal(native: NativeDatabase): Promise<void>;
  context(native: NativeDatabase): Context;
  rollback(native: NativeDatabase, begun: boolean, failure: unknown): void;
}

/** 读写事务共享同一连接 gate、失效规则及失败回滚策略。 */
export function sqliteTransaction(
  host: SqliteTransactionHost,
  callback: (tx: Transaction, ...args: unknown[]) => Promise<unknown>,
  readSignal?: AbortSignal,
) {
  if (typeof callback !== "function")
    throw new TypeError("The transaction callback must be a function");
  const execute = (mode: TransactionMode, args: unknown[]): Promise<unknown> => {
    const transaction = async (): Promise<unknown> => {
      host.assertUsable();
      assertNoTransactionReentry(host.id);
      if (host.readonly && !readSignal)
        throw createDatabaseError("SQLITE_READONLY", "Database is read-only");
      const native = await host.ready();
      const release = await host.gate.acquire(readSignal);
      let context: Context | undefined;
      let begun = false;
      let failure: unknown;
      let result: unknown;
      try {
        try {
          host.assertUsable();
          await host.activateWal(native);
          if (readSignal?.aborted)
            throw createDatabaseError(
              "PERIFUSE_READ_SNAPSHOT_CANCELLED",
              "Read snapshot cancelled",
            );
          await retryWhileBusy(() => native.run(`BEGIN ${mode}`), host.clock);
          begun = true;
          context = host.context(native);
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
          host.rollback(native, begun, failure);
          throw failure;
        }
        return result;
      } finally {
        context?.dispose();
        release();
      }
    };
    return host.pending.track(transaction());
  };
  return Object.assign((...args: unknown[]) => execute("DEFERRED", args), {
    deferred: (...args: unknown[]) => execute("DEFERRED", args),
    immediate: (...args: unknown[]) => execute("IMMEDIATE", args),
    exclusive: (...args: unknown[]) => execute("EXCLUSIVE", args),
  });
}
