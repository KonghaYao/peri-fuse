/**
 * v2 metrics filter translation (independent operator/type table).
 *
 * Translates the 10 filter types documented in the spec description
 * (datetime/string/number/stringOptions/categoryOptions/arrayOptions/
 * stringObject/numberObject/boolean/null) into SQLite WHERE fragments with
 * bound parameters. This module deliberately does NOT use the shared
 * clickhouse filter factory; every SQL fragment is built from the hardcoded
 * view catalog, user input only reaches queries as bound parameters.
 */
import { InvalidRequestError } from "@peri-fuse/shared";
import {
  METRICS_VIEW_DEFS,
  type MetricsV2Filter,
  type MetricViewName,
} from "../schemas/metrics-v2";

/** Compatible filter types per dimension type (langfuse filterTypeCompatibility). */
const COMPATIBLE_FILTER_TYPES: Record<string, readonly string[]> = {
  string: ["string", "stringOptions"],
  number: ["number"],
  boolean: ["boolean"],
  "string[]": ["arrayOptions"],
};

const FILTER_OPERATORS: Record<string, readonly string[]> = {
  datetime: [">", "<", ">=", "<="],
  string: ["=", "contains", "does not contain", "starts with", "ends with"],
  stringOptions: ["any of", "none of"],
  categoryOptions: ["any of", "none of"],
  arrayOptions: ["any of", "none of", "all of"],
  number: ["=", ">", "<", ">=", "<="],
  stringObject: ["=", "contains", "does not contain", "starts with", "ends with"],
  numberObject: ["=", ">", "<", ">=", "<="],
  boolean: ["=", "<>"],
  null: ["is null", "is not null"],
};

export type BuiltFilter = { sql: string; params: Record<string, unknown> };

/** ISO instant → SQLite TEXT timestamp ("YYYY-MM-DD HH:MM:SS.sss"). */
export function toSqliteTime(value: string): string {
  return new Date(value).toISOString().replace("T", " ").replace("Z", "");
}

/** Escape LIKE wildcards so user values match literally. */
function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** Build a SQLite json_extract path for a user-supplied metadata key. */
function jsonPath(key: string): string {
  return `$${key
    .split(".")
    .map((segment) => `."${segment.replaceAll('"', '\\"')}"`)
    .join("")}`;
}

/**
 * Translate one metrics filter into SQL + bound params. Throws
 * InvalidRequestError (→ 400) for unknown columns, incompatible types or
 * unknown operators.
 */
export function buildFilterSql(
  view: MetricViewName,
  filter: MetricsV2Filter,
  index: number,
): BuiltFilter {
  const def = METRICS_VIEW_DEFS[view];
  const operators = FILTER_OPERATORS[filter.type];
  if (!operators) {
    throw new InvalidRequestError(`Invalid filter type: ${filter.type}`);
  }
  if (!operators.includes(filter.operator)) {
    throw new InvalidRequestError(
      `Invalid filter for field '${filter.column}': Operator '${filter.operator}' is not supported for filter type '${filter.type}'. Expected ${operators.join(" or ")}.`,
    );
  }

  // Special filter columns not in the dimension catalog.
  if (filter.column === "metadata") {
    if (view !== "observations") {
      throw new InvalidRequestError(
        `Invalid filter for field 'metadata': only supported on the observations view.`,
      );
    }
    if (filter.type !== "stringObject" && filter.type !== "numberObject") {
      throw new InvalidRequestError(
        `Invalid filter for field 'metadata': Metadata filters require type 'stringObject' or 'numberObject' with a 'key' property, not '${filter.type}'.`,
      );
    }
    const field = `json_extract(o.metadata, '${jsonPath(filter.key)}')`;
    return stringOrNumberObjectClause(field, filter, index);
  }

  const dimension = def.dimensions[filter.column];
  if (!dimension) {
    throw new InvalidRequestError(
      `Invalid filter column: ${filter.column}. Must be one of ${Object.keys(def.dimensions).join(", ")}`,
    );
  }

  // `null` filters are compatible with every dimension type.
  if (filter.type === "null") {
    return {
      sql: `${dimension.sql} ${filter.operator}`,
      params: {},
    };
  }

  const compatible = COMPATIBLE_FILTER_TYPES[dimension.type];
  if (!compatible?.includes(filter.type)) {
    const expected = compatible ?? [];
    throw new InvalidRequestError(
      `Invalid filter for field '${filter.column}': Filter type '${filter.type}' is not supported for dimension type '${dimension.type}'. ` +
        `Expected ${expected.map((t) => `'${t}'`).join(" or ")}.`,
    );
  }

  switch (filter.type) {
    case "datetime": {
      const p = `f${index}`;
      return {
        sql: `${dimension.sql} ${filter.operator} @${p}`,
        params: { [p]: toSqliteTime(filter.value) },
      };
    }
    case "string":
      return stringClause(dimension.sql, filter, index);
    case "number": {
      const p = `f${index}`;
      return {
        sql: `${dimension.sql} ${filter.operator} @${p}`,
        params: { [p]: filter.value },
      };
    }
    case "stringOptions":
    case "categoryOptions":
      return inListClause(dimension.sql, filter, index);
    case "arrayOptions":
      return jsonArrayClause(dimension.sql, filter, index);
    case "boolean": {
      const p = `f${index}`;
      return {
        sql: `${dimension.sql} ${filter.operator} @${p}`,
        params: { [p]: filter.value ? 1 : 0 },
      };
    }
    default:
      throw new InvalidRequestError(`Invalid filter type: ${filter.type}`);
  }
}

function stringClause(
  field: string,
  filter: Extract<MetricsV2Filter, { type: "string" }>,
  index: number,
): BuiltFilter {
  const p = `f${index}`;
  const v = filter.value;
  switch (filter.operator) {
    case "=":
      return { sql: `${field} = @${p}`, params: { [p]: v } };
    case "contains":
      return { sql: `${field} LIKE @${p} ESCAPE '\\'`, params: { [p]: `%${escapeLike(v)}%` } };
    case "does not contain":
      return {
        sql: `(${field} IS NULL OR ${field} NOT LIKE @${p} ESCAPE '\\')`,
        params: { [p]: `%${escapeLike(v)}%` },
      };
    case "starts with":
      return { sql: `${field} LIKE @${p} ESCAPE '\\'`, params: { [p]: `${escapeLike(v)}%` } };
    case "ends with":
      return { sql: `${field} LIKE @${p} ESCAPE '\\'`, params: { [p]: `%${escapeLike(v)}` } };
    default:
      throw new InvalidRequestError(`Invalid operator: ${filter.operator}`);
  }
}

function stringOrNumberObjectClause(
  field: string,
  filter: Extract<MetricsV2Filter, { type: "stringObject" | "numberObject" }>,
  index: number,
): BuiltFilter {
  if (filter.type === "stringObject") {
    return stringClause(field, { ...filter, type: "string" }, index);
  }
  const p = `f${index}`;
  return { sql: `${field} ${filter.operator} @${p}`, params: { [p]: filter.value } };
}

function inListClause(
  field: string,
  filter: Extract<MetricsV2Filter, { type: "stringOptions" | "categoryOptions" }>,
  index: number,
): BuiltFilter {
  const params: Record<string, unknown> = {};
  const placeholders = filter.value.map((v, i) => {
    params[`f${index}_${i}`] = v;
    return `@f${index}_${i}`;
  });
  const inSql = `${field} IN (${placeholders.join(", ")})`;
  return {
    sql:
      filter.operator === "any of"
        ? inSql
        : `(${field} NOT IN (${placeholders.join(", ")}) OR ${field} IS NULL)`,
    params,
  };
}

/**
 * arrayOptions over a JSON-array TEXT column (traces.tags). json_valid guards
 * json_each so malformed/NULL values never raise.
 */
function jsonArrayClause(
  field: string,
  filter: Extract<MetricsV2Filter, { type: "arrayOptions" }>,
  index: number,
): BuiltFilter {
  const params: Record<string, unknown> = {};
  const placeholders = filter.value.map((v, i) => {
    params[`f${index}_${i}`] = v;
    return `@f${index}_${i}`;
  });
  const inList = placeholders.join(", ");
  const valid = `json_valid(${field})`;
  switch (filter.operator) {
    case "any of":
      return {
        sql: `${valid} AND EXISTS (SELECT 1 FROM json_each(${field}) je WHERE je.value IN (${inList}))`,
        params,
      };
    case "none of":
      return {
        sql: `NOT (${valid} AND EXISTS (SELECT 1 FROM json_each(${field}) je WHERE je.value IN (${inList})))`,
        params,
      };
    case "all of":
      return {
        sql: `${valid} AND (SELECT COUNT(DISTINCT je.value) FROM json_each(${field}) je WHERE je.value IN (${inList})) = ${filter.value.length}`,
        params,
      };
    default:
      throw new InvalidRequestError(`Invalid operator: ${filter.operator}`);
  }
}
