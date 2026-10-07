import { getTableName, type SQL, type Table } from "drizzle-orm";
import { mapColumnsInSQLToAlias } from "drizzle-orm/alias";

export function relationalFilter(condition: SQL | undefined) {
  return condition
    ? { RAW: (table: Table) => mapColumnsInSQLToAlias(condition, getTableName(table)) }
    : undefined;
}

export function relationalOrder(condition: SQL | SQL[]) {
  return (table: Table) =>
    (Array.isArray(condition) ? condition : [condition]).map((expression) =>
      mapColumnsInSQLToAlias(expression, getTableName(table)),
    );
}
