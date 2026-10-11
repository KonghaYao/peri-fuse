import type { Transaction } from "@tursodatabase/database";
import { type Connection, connect } from "@tursodatabase/serverless";
import type { DatabaseConnectionConfig } from "./connection-config";
import { createDatabaseError } from "./errors";
import type { ReadSnapshotProvider } from "./read-snapshot";

/** 仅交付协议实现：未有真实远端隔离证据，公共 CAS/GC 门禁保持关闭。 */
export function remoteReadSnapshotProvider(
  config: DatabaseConnectionConfig,
  executor: (connection: Connection) => Transaction,
): ReadSnapshotProvider {
  return {
    engine: "remote",
    supported: false,
    async run(callback, signal) {
      if (signal.aborted)
        throw createDatabaseError("PERIFUSE_READ_SNAPSHOT_CANCELLED", "Read snapshot cancelled");
      // connect 的所有 prepare/get/all/iterate 固定于同一个 serverless Session。
      // 不走 remote.ts 的独立 streamRows session，也不重连已失效的事务。
      const connection = connect(config);
      let begun = false;
      try {
        await connection.exec("BEGIN DEFERRED");
        begun = true;
        const result = await callback(executor(connection));
        await connection.exec("COMMIT");
        return result;
      } catch (error) {
        if (begun) {
          try {
            await connection.exec("ROLLBACK");
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Read snapshot rollback failed");
          }
        }
        throw error;
      } finally {
        await connection.close();
      }
    },
  };
}
