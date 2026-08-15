/**
 * v2 metrics query execution + shaping (GET /api/public/v2/metrics).
 *
 * Two-phase execution against the lite telemetry SQLite store:
 *   - Query A (aggregated): GROUP BY over the requested dimensions (+ optional
 *     time bucket), computing sum/avg/count/max/min directly in SQL.
 *   - Query B (raw, only when p50..p99/histogram are requested): same WHERE,
 *     no GROUP BY, selecting the group keys plus the raw per-row measure
 *     expressions; percentiles/histograms are then computed in JS per group
 *     (SQLite has no quantile/histogram aggregate).
 *
 * Filter translation lives in metrics-v2-filters.ts (independent operator/type
 * table per the spec description). All SQL fragments come from the view
 * catalog in schemas/metrics-v2.ts; user input only reaches queries as bound
 * parameters.
 */
import { InvalidRequestError } from "@peri-fuse/shared";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import {
  METRICS_VIEW_DEFS,
  type MetricAggregation,
  type MetricGranularity,
  type MetricsV2Query,
  type MetricViewName,
} from "../schemas/metrics-v2";
import { buildFilterSql, toSqliteTime } from "./metrics-v2-filters";

/** Aggregations computed inside SQL (the rest need raw values). */
const SQL_AGGREGATIONS = new Set<MetricAggregation>(["sum", "avg", "count", "max", "min"]);
const RAW_AGGREGATIONS = new Set<MetricAggregation>([
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "histogram",
]);

type Row = Record<string, unknown>;

const DEFAULT_ROW_LIMIT = 100;
const DEFAULT_BINS = 10;

// ---------------------------------------------------------------------------
// Aggregation math (SQLite has no quantile/histogram aggregates)
// ---------------------------------------------------------------------------

/**
 * ClickHouse-style equal-width histogram: [lower, upper, height] tuples.
 * Empty values → []; single distinct value → [[min, max, count]].
 */
export function computeHistogram(
  values: Array<number | null>,
  bins: number,
): Array<[number, number, number]> {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const x of v) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (min === max) return [[min, max, v.length]];
  const width = (max - min) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const x of v) {
    let idx = Math.floor((x - min) / width);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
  }
  return counts.map((height, i) => [
    min + i * width,
    i === bins - 1 ? max : min + (i + 1) * width,
    height,
  ]);
}

/** Linear-interpolation percentile (matches ClickHouse `quantile` closely). */
export function computePercentile(values: Array<number | null>, p: number): number | null {
  const v = values
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (v.length === 0) return null;
  const idx = p * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

// ---------------------------------------------------------------------------
// Time bucketing
// ---------------------------------------------------------------------------

/** langfuse `determineTimeGranularity`: ~50 buckets over the window. */
export function autoGranularity(fromIso: string, toIso: string): MetricGranularity {
  const diffHours = (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000;
  if (diffHours < 2) return "minute";
  if (diffHours < 72) return "hour";
  if (diffHours < 1440) return "day";
  if (diffHours < 8760) return "week";
  return "month";
}

function timeBucketSql(column: string, granularity: MetricGranularity): string {
  switch (granularity) {
    case "minute":
      return `strftime('%Y-%m-%d %H:%M:00', ${column})`;
    case "hour":
      return `strftime('%Y-%m-%d %H:00:00', ${column})`;
    case "day":
      return `strftime('%Y-%m-%d', ${column})`;
    case "week":
      // Monday of the week (UTC); ClickHouse toMonday equivalent.
      return `date(${column}, printf('-%d days', ((strftime('%w', ${column}) + 6) % 7)))`;
    case "month":
      return `strftime('%Y-%m-01', ${column})`;
    case "auto":
      throw new InvalidRequestError("Granularity 'auto' must be resolved before bucketing");
    default:
      throw new InvalidRequestError(`Invalid time granularity: ${granularity}`);
  }
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

const TRACE_JOIN_OBS = `LEFT JOIN traces t ON t.project_id = o.project_id AND t.id = o.trace_id AND t.is_deleted = 0`;
const TRACE_JOIN_SCORES = `LEFT JOIN traces t ON t.project_id = s.project_id AND t.id = s.trace_id AND t.is_deleted = 0`;
const OBS_JOIN_SCORES = `LEFT JOIN observations ob ON ob.project_id = s.project_id AND ob.id = s.observation_id AND ob.is_deleted = 0`;

type PreparedQuery = {
  viewDef: (typeof METRICS_VIEW_DEFS)[MetricViewName];
  dimFields: string[];
  dimSqls: string[];
  timeBucketSql: string | null;
  fromSqlite: string;
  toSqlite: string;
  whereSql: string;
  params: Record<string, unknown>;
  joins: string[];
};

function prepareQuery(projectId: string, query: MetricsV2Query): PreparedQuery {
  const viewDef = METRICS_VIEW_DEFS[query.view];

  // --- dimensions -----------------------------------------------------------
  const dimFields = query.dimensions.map((d) => d.field);
  for (const field of dimFields) {
    if (!(field in viewDef.dimensions)) {
      throw new InvalidRequestError(
        `Invalid dimension ${field}. Must be one of ${Object.keys(viewDef.dimensions).join(", ")}`,
      );
    }
    if (viewDef.dimensions[field].highCardinality) {
      // lite policy: high-cardinality dimensions are filter-only (see plan T5).
      throw new InvalidRequestError(
        `High cardinality dimension(s) '${field}' require both 'config.row_limit' and 'orderBy' with direction 'desc' on a measure field.`,
      );
    }
  }
  const dimSqls = dimFields.map((f) => viewDef.dimensions[f].sql);

  // --- measures -------------------------------------------------------------
  for (const m of query.metrics) {
    const measureDef = viewDef.measures[m.measure];
    if (!measureDef) {
      throw new InvalidRequestError(
        `Invalid metric ${m.measure}. Must be one of ${Object.keys(viewDef.measures).join(", ")}`,
      );
    }
    if (!SQL_AGGREGATIONS.has(m.aggregation) && !RAW_AGGREGATIONS.has(m.aggregation)) {
      throw new InvalidRequestError(
        `Aggregation "${m.aggregation}" is not valid for measure "${m.measure}" (type: ${measureDef.type}). Valid aggregations: ${[...SQL_AGGREGATIONS, ...RAW_AGGREGATIONS].join(", ")}`,
      );
    }
  }

  // --- time bucketing -------------------------------------------------------
  let bucketSql: string | null = null;
  if (query.timeDimension) {
    const granularity =
      query.timeDimension.granularity === "auto"
        ? autoGranularity(query.fromTimestamp, query.toTimestamp)
        : query.timeDimension.granularity;
    bucketSql = timeBucketSql(viewDef.timeColumn, granularity);
  }

  // --- filters --------------------------------------------------------------
  const fromSqlite = toSqliteTime(query.fromTimestamp);
  const toSqlite = toSqliteTime(query.toTimestamp);
  const baseAlias = viewDef.baseTable.split(" ")[1];
  const whereParts = [
    `${baseAlias}.project_id = @projectId`,
    `${baseAlias}.is_deleted = 0`,
    `${viewDef.timeColumn} >= @from`,
    `${viewDef.timeColumn} <= @to`,
  ];
  const params: Record<string, unknown> = { projectId, from: fromSqlite, to: toSqlite };
  if (viewDef.segmentSql) whereParts.push(viewDef.segmentSql);
  query.filters.forEach((filter, i) => {
    const built = buildFilterSql(query.view, filter, i);
    whereParts.push(built.sql);
    Object.assign(params, built.params);
  });

  // --- joins (only when trace/observation fields are actually used) ---------
  const usedFields = new Set([...dimFields, ...query.filters.map((f) => f.column)]);
  const joins: string[] = [];
  if (query.view === "observations") {
    const traceFields = [
      "tags",
      "release",
      "traceName",
      "traceRelease",
      "traceVersion",
      "userId",
      "sessionId",
    ];
    if (traceFields.some((f) => usedFields.has(f))) joins.push(TRACE_JOIN_OBS);
  } else {
    const traceFields = [
      "traceName",
      "tags",
      "traceRelease",
      "traceVersion",
      "userId",
      "sessionId",
    ];
    if (traceFields.some((f) => usedFields.has(f))) joins.push(TRACE_JOIN_SCORES);
    const obsFields = [
      "observationName",
      "observationModelName",
      "observationPromptName",
      "observationPromptVersion",
    ];
    if (obsFields.some((f) => usedFields.has(f))) joins.push(OBS_JOIN_SCORES);
  }

  return {
    viewDef,
    dimFields,
    dimSqls,
    timeBucketSql: bucketSql,
    fromSqlite,
    toSqlite,
    whereSql: whereParts.join(" AND "),
    params,
    joins,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type MetricsRow = {
  dims: Record<string, unknown>;
  metrics: Record<string, unknown>;
};

const AGG_SQL: Record<string, (sql: string) => string> = {
  sum: (sql) => `SUM(${sql})`,
  avg: (sql) => `AVG(${sql})`,
  count: (sql) => `COUNT(${sql})`,
  max: (sql) => `MAX(${sql})`,
  min: (sql) => `MIN(${sql})`,
};

export function metricKey(aggregation: MetricAggregation, measure: string): string {
  return `${aggregation}_${measure}`;
}

/**
 * Run the v2 metrics query and return the MetricsV2Response body.
 * Throws InvalidRequestError (→ 400 via app.ts onError) on validation errors.
 */
export async function queryMetricsV2(
  projectId: string,
  query: MetricsV2Query,
): Promise<{ data: Row[] }> {
  const p = prepareQuery(projectId, query);
  const db = getTelemetryDB();
  const joinsSql = p.joins.length ? ` ${p.joins.join(" ")}` : "";
  const fromClause = `FROM ${p.viewDef.baseTable}${joinsSql}`;
  const whereClause = `WHERE ${p.whereSql}`;

  const groupParts = [...p.dimSqls, ...(p.timeBucketSql ? [p.timeBucketSql] : [])];
  const groupByClause = groupParts.length > 0 ? `GROUP BY ${groupParts.join(", ")}` : "";
  const dimAliases = [...p.dimFields, ...(p.timeBucketSql ? ["time_dimension"] : [])];

  // ---- Query A: SQL-computable aggregations --------------------------------
  const sqlMetrics = query.metrics.filter((m) => SQL_AGGREGATIONS.has(m.aggregation));
  const selectParts: string[] = [];
  p.dimFields.forEach((field, i) => selectParts.push(`${p.dimSqls[i]} AS ${field}`));
  if (p.timeBucketSql) selectParts.push(`${p.timeBucketSql} AS time_dimension`);
  for (const m of sqlMetrics) {
    selectParts.push(
      `${AGG_SQL[m.aggregation](p.viewDef.measures[m.measure].rawSql)} AS ${metricKey(m.aggregation, m.measure)}`,
    );
  }
  if (selectParts.length === 0) selectParts.push("1 AS __empty"); // metrics are all raw-agg

  const aggRows = await db.query<Row>({
    query: `SELECT ${selectParts.join(", ")} ${fromClause} ${whereClause} ${groupByClause}`,
    params: p.params,
  });

  const rows = new Map<string, MetricsRow>();
  const groupKey = (values: unknown[]): string => JSON.stringify(values);
  for (const row of aggRows) {
    const dims: Record<string, unknown> = {};
    const keyValues: unknown[] = [];
    for (const field of dimAliases) {
      dims[field] = row[field];
      keyValues.push(row[field]);
    }
    const metrics: Record<string, unknown> = {};
    for (const m of sqlMetrics) {
      metrics[metricKey(m.aggregation, m.measure)] = row[metricKey(m.aggregation, m.measure)];
    }
    rows.set(groupKey(keyValues), { dims, metrics });
  }

  // ---- Query B: raw values for percentiles / histograms --------------------
  const rawMetrics = query.metrics.filter((m) => RAW_AGGREGATIONS.has(m.aggregation));
  if (rawMetrics.length > 0) {
    const rawSelect: string[] = [];
    p.dimFields.forEach((field, i) => rawSelect.push(`${p.dimSqls[i]} AS ${field}`));
    if (p.timeBucketSql) rawSelect.push(`${p.timeBucketSql} AS time_dimension`);
    rawMetrics.forEach((m, i) =>
      rawSelect.push(`${p.viewDef.measures[m.measure].rawSql} AS __raw${i}`),
    );
    const rawRows = await db.query<Row>({
      query: `SELECT ${rawSelect.join(", ")} ${fromClause} ${whereClause}`,
      params: p.params,
    });

    const buckets = new Map<string, Array<Array<number | null>>>();
    for (const row of rawRows) {
      const key = groupKey(dimAliases.map((field) => row[field]));
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = rawMetrics.map(() => []);
        buckets.set(key, bucket);
      }
      rawMetrics.forEach((_m, i) => {
        const v = row[`__raw${i}`];
        bucket![i].push(typeof v === "number" ? v : null);
      });
    }

    for (const [key, values] of buckets) {
      let entry = rows.get(key);
      if (!entry) {
        const dims: Record<string, unknown> = {};
        const parsed = JSON.parse(key) as unknown[];
        dimAliases.forEach((field, i) => {
          dims[field] = parsed[i];
        });
        entry = { dims, metrics: {} };
        rows.set(key, entry);
      }
      rawMetrics.forEach((m, i) => {
        if (m.aggregation === "histogram") {
          entry!.metrics[metricKey("histogram", m.measure)] = computeHistogram(
            values[i],
            query.config?.bins ?? DEFAULT_BINS,
          );
        } else {
          const pct = Number(m.aggregation.slice(1)) / 100;
          entry!.metrics[metricKey(m.aggregation, m.measure)] = computePercentile(values[i], pct);
        }
      });
    }
  }

  // ---- Ordering + row limit (JS: keys include computed raw aggregations) ----
  const effectiveOrderBy = resolveOrderBy(query, p.dimFields, p.timeBucketSql !== null);
  let data = Array.from(rows.values());
  if (effectiveOrderBy.length > 0) {
    data = data.sort((a, b) => compareRows(a, b, effectiveOrderBy));
  }
  data = data.slice(0, query.config?.row_limit ?? DEFAULT_ROW_LIMIT);

  return { data: data.map((r) => shapeRow(r, p.viewDef)) };
}

/** Default order (langfuse): time_dimension asc → first metric desc → first dim asc. */
function resolveOrderBy(
  query: MetricsV2Query,
  dimFields: string[],
  hasTimeBucket: boolean,
): Array<{ field: string; direction: "asc" | "desc" }> {
  let orderBy: Array<{ field: string; direction: "asc" | "desc" }>;
  const requested = query.orderBy ?? null;
  if (!requested || requested.length === 0) {
    if (hasTimeBucket) orderBy = [{ field: "time_dimension", direction: "asc" }];
    else if (query.metrics.length > 0) {
      const first = query.metrics[0];
      orderBy = [{ field: metricKey(first.aggregation, first.measure), direction: "desc" }];
    } else if (dimFields.length > 0) {
      orderBy = [{ field: dimFields[0], direction: "asc" }];
    } else {
      orderBy = [];
    }
  } else {
    orderBy = requested;
  }

  const knownMetricKeys = new Set(query.metrics.map((m) => metricKey(m.aggregation, m.measure)));
  const knownDimKeys = new Set([...dimFields, ...(hasTimeBucket ? ["time_dimension"] : [])]);
  for (const o of orderBy) {
    if (!knownDimKeys.has(o.field) && !knownMetricKeys.has(o.field)) {
      throw new InvalidRequestError(
        `Invalid orderBy field: ${o.field}. Must be one of the dimension or metric fields.`,
      );
    }
  }
  return orderBy;
}

function compareRows(
  a: MetricsRow,
  b: MetricsRow,
  orderBy: Array<{ field: string; direction: "asc" | "desc" }>,
): number {
  for (const o of orderBy) {
    const va = a.dims[o.field] ?? a.metrics[o.field];
    const vb = b.dims[o.field] ?? b.metrics[o.field];
    // Histogram arrays are not sortable — skip (stable order preserved).
    if (Array.isArray(va) || Array.isArray(vb)) continue;
    let cmp: number;
    if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
    else cmp = String(va ?? "").localeCompare(String(vb ?? ""));
    if (cmp !== 0) return o.direction === "asc" ? cmp : -cmp;
  }
  return 0;
}

/** Shape a row: booleans → true/false, JSON-array dims → arrays. */
function shapeRow(entry: MetricsRow, viewDef: (typeof METRICS_VIEW_DEFS)[MetricViewName]): Row {
  const row: Row = {};
  for (const [field, value] of Object.entries(entry.dims)) {
    row[field] = shapeValue(field, value, viewDef);
  }
  for (const [key, value] of Object.entries(entry.metrics)) {
    row[key] = value !== null && typeof value === "number" && Number.isNaN(value) ? null : value;
  }
  return row;
}

function shapeValue(
  field: string,
  value: unknown,
  viewDef: (typeof METRICS_VIEW_DEFS)[MetricViewName],
): unknown {
  if (value === null || value === undefined) return null;
  const dim = viewDef.dimensions[field];
  if (dim?.type === "boolean") return value === 1 || value === true;
  if (dim?.type === "string[]") {
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }
    return value;
  }
  return value;
}
