import type { Database, Transaction } from "@tursodatabase/database";
import {
  type Connection,
  connect,
  decodeValue,
  type QueryOptions,
  Session,
  type Statement,
} from "@tursodatabase/serverless";
import type { DatabaseConnectionConfig } from "./connection-config";

const configurations = new WeakMap<object, DatabaseConnectionConfig>();

export function getRemoteDatabaseConfig(database: object): DatabaseConnectionConfig | undefined {
  return configurations.get(database);
}

function statementArguments(parameters: unknown[]): unknown {
  const value = parameters[0];
  if (
    parameters.length === 1 &&
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array)
  )
    return value;
  return parameters;
}

async function* streamRows(
  config: DatabaseConnectionConfig,
  sql: string,
  parameters: unknown,
  options?: QueryOptions,
) {
  const session = new Session(config);
  try {
    await session.sequence("PRAGMA query_only = 1", options);
    const { entries } = await session.executeRaw(
      sql,
      parameters as unknown[] | Record<string, unknown>,
      options,
    );
    for await (const entry of entries) {
      if (entry.type === "row") yield (entry.row ?? []).map((value) => decodeValue(value));
      else if (entry.type === "step_error" || entry.type === "error")
        throw new Error(entry.error?.message ?? "Remote query failed");
    }
  } finally {
    await session.close();
  }
}

function wrapStatement(
  statement: Statement,
  stream?: (parameters: unknown, options?: QueryOptions) => AsyncGenerator<unknown[]>,
) {
  let raw = false;
  let pluck = false;
  const wrapper = {
    get reader() {
      return statement.reader;
    },
    columns: () => statement.columns(),
    close: () => undefined,
    raw(enabled = true) {
      raw = enabled;
      statement.raw(enabled);
      return wrapper;
    },
    pluck(enabled = true) {
      pluck = enabled;
      statement.pluck(enabled);
      return wrapper;
    },
    safeIntegers(enabled?: boolean) {
      statement.safeIntegers(enabled);
      return wrapper;
    },
    get: (...parameters: unknown[]) => statement.get(statementArguments(parameters)),
    all: (...parameters: unknown[]) => statement.all(statementArguments(parameters)),
    run: (...parameters: unknown[]) => statement.run(statementArguments(parameters)),
    async *iterate(parameters?: unknown, options?: QueryOptions) {
      if (!stream) {
        yield* statement.iterate(parameters, options);
        return;
      }
      const columns = statement.columns().map((column: { name: string }) => column.name);
      for await (const row of stream(parameters ?? [], options)) {
        yield pluck
          ? row[0]
          : raw
            ? row
            : Object.fromEntries(columns.map((name, index) => [name, row[index]]));
      }
    },
  };
  return wrapper;
}

function executor(connection: Connection, config?: DatabaseConnectionConfig) {
  return {
    exec: (sql: string) => connection.exec(sql),
    run: (sql: string, ...parameters: unknown[]) => connection.run(sql, ...parameters),
    get: (sql: string, ...parameters: unknown[]) => connection.get(sql, ...parameters),
    all: (sql: string, ...parameters: unknown[]) => connection.all(sql, ...parameters),
    prepare: async (sql: string) =>
      wrapStatement(
        await connection.prepare(sql),
        config ? (parameters, options) => streamRows(config, sql, parameters, options) : undefined,
      ),
    async *iterate(sql: string, parameters?: unknown, options?: QueryOptions) {
      const statement = wrapStatement(
        await connection.prepare(sql),
        config
          ? (values, queryOptions) => streamRows(config, sql, values, queryOptions)
          : undefined,
      );
      yield* statement.iterate(parameters, options);
    },
  };
}

export function createRemoteDatabase(config: DatabaseConnectionConfig, readonly = false): Database {
  const connection = connect(config);
  const transactions = new Set<Promise<unknown>>();
  let closed = false;
  const database = {
    ...executor(connection, config),
    name: config.url,
    async connect() {
      if (closed) throw new Error("Database is closed");
      if (readonly) await connection.exec("PRAGMA query_only = 1");
    },
    async close() {
      closed = true;
      await Promise.allSettled([...transactions]);
      await connection.close();
    },
    transactionAsync<T, Args extends unknown[]>(
      callback: (tx: Transaction, ...args: Args) => Promise<T>,
    ) {
      const execute = (behavior: string, args: Args): Promise<T> => {
        if (closed) return Promise.reject(new Error("Database is closed"));
        if (readonly) return Promise.reject(new Error("Database is read-only"));
        const pending = (async () => {
          const transaction = connect(config);
          let begun = false;
          try {
            await transaction.exec("PRAGMA foreign_keys = ON");
            await transaction.exec(`BEGIN ${behavior}`);
            begun = true;
            const result = await callback(executor(transaction) as unknown as Transaction, ...args);
            await transaction.exec("COMMIT");
            return result;
          } catch (error) {
            if (begun) await transaction.exec("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await transaction.close();
          }
        })();
        transactions.add(pending);
        void pending.then(
          () => transactions.delete(pending),
          () => transactions.delete(pending),
        );
        return pending;
      };
      return Object.assign((...args: Args) => execute("DEFERRED", args), {
        deferred: (...args: Args) => execute("DEFERRED", args),
        immediate: (...args: Args) => execute("IMMEDIATE", args),
        exclusive: (...args: Args) => execute("EXCLUSIVE", args),
      });
    },
  };
  configurations.set(database, config);
  return database as unknown as Database;
}
