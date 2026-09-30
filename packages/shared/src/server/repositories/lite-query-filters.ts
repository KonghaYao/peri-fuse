import { InvalidRequestError } from "../../errors";
import type { FilterList } from "../queries/clickhouse-sql/clickhouse-filter";

/**
 * Column whitelist per table to avoid SQL injection through filter.field.
 * Filter `field` values originate from server-side column mappings, but we
 * still guard against unexpected fields.
 */
const LITE_FILTER_COLUMNS: Record<string, Set<string>> = {
  observations: new Set([
    "trace_id",
    "name",
    "level",
    "type",
    "parent_observation_id",
    "start_time",
    "end_time",
    "environment",
    "version",
    "id",
    "model",
  ]),
  scores: new Set([
    "trace_id",
    "observation_id",
    "name",
    "source",
    "timestamp",
    "value",
    "data_type",
    "config_id",
    "environment",
    "id",
    "author_user_id",
    "queue_id",
    "metadata",
    "session_id",
  ]),
  traces: new Set([
    "id",
    "name",
    "user_id",
    "session_id",
    "environment",
    "timestamp",
    "version",
    "release",
  ]),
};

/** Format a Date to SQLite TEXT format matching datetime('now') storage. */
function toSqliteDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
}

/** Escape a literal for use inside a SQLite LIKE pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Strip a table prefix from a clickhouseSelect ('t.user_id' -> 'user_id').
 * Column mappings for traces-table columns use prefixed selects ('t.user_id',
 * 't.tags', 't.name') while the special-case branches below match bare names.
 */
function stripTablePrefix(field: string): string {
  const dot = field.indexOf(".");
  return dot > 0 ? field.slice(dot + 1) : field;
}

/**
 * Convert a FilterList into a SQLite WHERE clause (without the `WHERE` keyword)
 * plus bound parameters. Supports the filter types used by the public API
 * observations/scores/traces endpoints.
 *
 * Filters on columns that cannot be executed against the target table are NOT
 * silently dropped: trace-property filters (user_id/session_id/trace_name/tags)
 * are lowered to EXISTS subqueries on `traces`, `dataset_run_id` (lite has no
 * dataset-run scores) compiles to a constant-false clause, and any other
 * column outside the per-table whitelist raises InvalidRequestError (400)
 * instead of returning unfiltered data.
 *
 * The base query is expected to already constrain `project_id` and
 * `is_deleted = 0`.
 */
export function liteBuildFilterWhere(
  filter: FilterList | undefined,
  table: "observations" | "scores" | "traces",
): { clause: string; params: Record<string, unknown> } {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (!filter || filter.length === 0) return { clause: "", params };

  const columns = LITE_FILTER_COLUMNS[table];
  let idx = 0;

  filter.forEach((f) => {
    const raw = f as unknown as Record<string, unknown>;
    const field = String(raw.field ?? "");
    const operator = String(raw.operator ?? "");
    const clickhouseTable = String(raw.clickhouseTable ?? table);

    // project_id / is_deleted are enforced by the base query.
    if (field === "project_id" || field === "is_deleted") return;

    // Trace-property filters on observations live on the traces table ->
    // EXISTS subqueries.
    if (table === "observations" && clickhouseTable === "traces") {
      const traceField = stripTablePrefix(field);
      if (traceField === "user_id" || traceField === "session_id" || traceField === "trace_name") {
        const p = `uf${idx++}`;
        params[p] = String(raw.value ?? "");
        const traceColumn = traceField === "trace_name" ? "name" : traceField;
        conditions.push(
          `trace_id IN (SELECT id FROM traces WHERE project_id = @projectId AND ${traceColumn} = @${p})`,
        );
        return;
      }
      // Trace-tag filters -> match the JSON tags array on traces.
      // "all of" requires every tag; "any of" matches any tag.
      if (traceField === "tags") {
        const values = Array.isArray(raw.values) ? (raw.values as unknown[]) : [];
        if (values.length === 0) return;
        const parts = values.map((v) => {
          const p = `tag${idx++}`;
          params[p] = `%"${escapeLike(String(v))}"%`;
          return `t.tags LIKE @${p}`;
        });
        if (operator === "none of") {
          conditions.push(
            `trace_id NOT IN (SELECT t.id FROM traces t WHERE t.project_id = @projectId AND (${parts.join(" OR ")}))`,
          );
        } else {
          conditions.push(
            `trace_id IN (SELECT t.id FROM traces t WHERE t.project_id = @projectId AND ${operator === "all of" ? parts.join(" AND ") : `(${parts.join(" OR ")})`})`,
          );
        }
        return;
      }
      throw new InvalidRequestError(
        `Filter column "${field}" on table "traces" is not supported for observations in lite mode`,
      );
    }

    // Trace-property filters on scores -> EXISTS subqueries on traces.
    if (table === "scores" && clickhouseTable === "traces") {
      const traceField = stripTablePrefix(field);
      if (traceField === "user_id") {
        const p = `uf${idx++}`;
        params[p] = String(raw.value ?? "");
        conditions.push(
          `trace_id IN (SELECT id FROM traces WHERE project_id = @projectId AND user_id = @${p})`,
        );
        return;
      }
      // Spec (v2/scores traceTags): "Only scores linked to traces that include
      // ALL of these tags will be returned" — "all of" requires every tag.
      if (traceField === "tags") {
        const values = Array.isArray(raw.values) ? (raw.values as unknown[]) : [];
        if (values.length === 0) return;
        const parts = values.map((v) => {
          const p = `tag${idx++}`;
          params[p] = `%"${escapeLike(String(v))}"%`;
          return `t.tags LIKE @${p}`;
        });
        if (operator === "none of") {
          conditions.push(
            `trace_id NOT IN (SELECT t.id FROM traces t WHERE t.project_id = @projectId AND (${parts.join(" OR ")}))`,
          );
        } else {
          conditions.push(
            `trace_id IN (SELECT t.id FROM traces t WHERE t.project_id = @projectId AND ${operator === "all of" ? parts.join(" AND ") : `(${parts.join(" OR ")})`})`,
          );
        }
        return;
      }
      if (traceField === "trace_name" || traceField === "name") {
        const p = `uf${idx++}`;
        params[p] = String(raw.value ?? "");
        conditions.push(
          `trace_id IN (SELECT id FROM traces WHERE project_id = @projectId AND name = @${p})`,
        );
        return;
      }
      throw new InvalidRequestError(
        `Filter column "${field}" on table "traces" is not supported for scores in lite mode`,
      );
    }

    // Tags filter directly on the traces table (JSON array column).
    if (table === "traces" && field === "tags" && Array.isArray(raw.values)) {
      const values = (raw.values as unknown[]).map((v) => String(v));
      if (values.length === 0) return;
      if (operator === "none of") {
        const ands = values.map((v) => {
          const p = `tag${idx++}`;
          params[p] = v;
          return `NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = @${p})`;
        });
        conditions.push(ands.join(" AND "));
      } else {
        // "any of" / "all of" — for all of, require every value present.
        const parts = values.map((v) => {
          const p = `tag${idx++}`;
          params[p] = v;
          return `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = @${p})`;
        });
        conditions.push(operator === "all of" ? parts.join(" AND ") : `(${parts.join(" OR ")})`);
      }
      return;
    }

    // Lite has no dataset-run scores: a dataset_run_id filter matches nothing.
    if (table === "scores" && stripTablePrefix(field) === "dataset_run_id") {
      conditions.push("1 = 0");
      return;
    }

    // Only handle filters whose column exists on the target table. For
    // json_extract() expressions (stringObject filters on JSON columns) the
    // whitelist is validated against the extracted base column. Anything else
    // is a column the lite mode cannot execute -> explicit 400 instead of
    // silently returning unfiltered data.
    const jsonExtractMatch = /^json_extract\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/.exec(field);
    const baseColumn = jsonExtractMatch ? jsonExtractMatch[1] : field;
    if (clickhouseTable !== table && clickhouseTable !== "") {
      throw new InvalidRequestError(
        `Filter column "${field}" on table "${clickhouseTable}" is not supported for ${table} in lite mode`,
      );
    }
    if (!columns.has(baseColumn)) {
      throw new InvalidRequestError(
        `Filter column "${field}" is not supported for ${table} in lite mode`,
      );
    }

    const col = field;

    // Null filter (is null / is not null)
    if (operator === "is null" || operator === "is not null") {
      conditions.push(`${col} ${operator === "is null" ? "IS NULL" : "IS NOT NULL"}`);
      return;
    }

    // String options filter (any of / none of)
    if (Array.isArray(raw.values)) {
      const values = (raw.values as unknown[]).map((v) => String(v));
      if (values.length === 0) return;
      const placeholders = values.map((v) => {
        const p = `opt${idx++}`;
        params[p] = v;
        return `@${p}`;
      });
      if (operator === "none of") {
        conditions.push(`${col} NOT IN (${placeholders.join(",")})`);
      } else {
        conditions.push(`${col} IN (${placeholders.join(",")})`);
      }
      return;
    }

    // DateTime filter
    if (raw.value instanceof Date) {
      const p = `dt${idx++}`;
      params[p] = toSqliteDateTime(raw.value as Date);
      conditions.push(`${col} ${operator} @${p}`);
      return;
    }

    // Number filter
    if (typeof raw.value === "number") {
      const p = `num${idx++}`;
      params[p] = raw.value;
      conditions.push(`${col} ${operator} @${p}`);
      return;
    }

    // Boolean filter (SQLite stores booleans as 0/1)
    if (typeof raw.value === "boolean") {
      const p = `bool${idx++}`;
      params[p] = raw.value ? 1 : 0;
      conditions.push(`${col} ${operator === "<>" ? "!=" : operator} @${p}`);
      return;
    }

    // String filter
    if (typeof raw.value === "string") {
      const value = raw.value as string;
      const p = `str${idx++}`;
      switch (operator) {
        case "=":
          params[p] = value;
          conditions.push(`${col} = @${p}`);
          break;
        case "!=":
          params[p] = value;
          conditions.push(`${col} != @${p}`);
          break;
        case "contains":
          params[p] = `%${escapeLike(value)}%`;
          conditions.push(`${col} LIKE @${p}`);
          break;
        case "does not contain":
          params[p] = `%${escapeLike(value)}%`;
          conditions.push(`${col} NOT LIKE @${p}`);
          break;
        case "starts with":
          params[p] = `${escapeLike(value)}%`;
          conditions.push(`${col} LIKE @${p}`);
          break;
        case "ends with":
          params[p] = `%${escapeLike(value)}`;
          conditions.push(`${col} LIKE @${p}`);
          break;
        default:
          params[p] = value;
          conditions.push(`${col} = @${p}`);
      }
      return;
    }
  });

  return {
    clause: conditions.length > 0 ? conditions.join(" AND ") : "",
    params,
  };
}
