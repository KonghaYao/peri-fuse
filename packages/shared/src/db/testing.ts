import type { vi } from "vitest";
import type { LocalDatabase } from "./local.js";

export function rejectSql(database: LocalDatabase, pattern: RegExp, spy: typeof vi) {
  const transaction = database.transactionAsync.bind(database);
  return spy.spyOn(database, "transactionAsync").mockImplementation((callback) =>
    transaction(async (tx, ...args) => {
      const proxy = new Proxy(tx, {
        get(target, name) {
          const value = Reflect.get(target, name);
          if (["run", "get", "all", "exec", "prepare"].includes(String(name)))
            return (query: string, ...parameters: unknown[]) => {
              if (pattern.test(query)) throw new Error("synthetic database failure");
              return value.call(target, query, ...parameters);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return callback(proxy, ...args);
    }),
  );
}
