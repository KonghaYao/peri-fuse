/**
 * Scale corpus loader for the session list benchmark
 * (`sessions-scale-bench.test.ts`).
 *
 * Writes `traces` + `trace_metrics` for a dedicated project straight through the
 * telemetry adapter (`command`), bypassing ingestion. The session list route
 * only reads those two tables, and pushing 100k+ records through the public
 * ingestion API would spend the benchmark runtime on validation, metrics
 * maintenance and WAL bookkeeping instead of measuring the read path.
 *
 * Rows are generated inside SQL by a recursive CTE and inserted in chunks
 * (`TRACE_CHUNK_ROWS` rows per statement) so a single statement never has to
 * materialise the whole corpus. Numbering is deterministic:
 *
 *   trace N (0..traceCount-1) -> 'scale-trace-N'
 *   session                   -> 'scale-session-' || floor(N / 5)
 *
 * The value distribution mirrors the 1k corpus (`sessions-bench-corpus.ts`):
 * ~90% of the traces carry a `trace_metrics` row while session 2 has none at
 * all (NULL metric sums), traces 1 and 11 are soft-deleted, 10% have a NULL
 * user id, one user id contains commas, and tags/environment vary per trace.
 * Metric values stay self-consistent (total = input + output, token sums).
 *
 * Timestamps span 30 days from `CORPUS_START` in the `YYYY-MM-DD HH:MM:SS.sss`
 * format ingestion writes (see `toSqliteTime` in the server shaping layer);
 * `strftime('%f')` produces the millisecond field.
 */
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { createSecondProject } from "./second-project";

/** Traces per session (same grouping as the 1k corpus). */
export const TRACES_PER_SESSION = 5;
/** Rows per INSERT statement: large enough to amortise, small enough to stay bounded. */
export const TRACE_CHUNK_ROWS = 20_000;
export const METRIC_CHUNK_ROWS = 20_000;
/** Corpus window: 30 days, one trace every 7 minutes (wraps for large corpora). */
const SPREAD_MINUTES = 30 * 24 * 60;
const CORPUS_START = "2026-01-01 00:00:00";

export interface ScaleCorpus {
  projectId: string;
  auth: string;
  traceCount: number;
  metricCount: number;
  sessionCount: number;
  /** Insert + verification time (excluding `ANALYZE`). */
  seedMs: number;
  analyzeMs: number;
}

/**
 * Row index inside one chunk. The CAST pins the bound offset to INTEGER:
 * float arithmetic would turn `floor(N / 5)` into `4000.0` and leak into the
 * generated ids.
 */
const rowId = "(CAST(@start AS INTEGER) + n)";
/** Parenthesised: `||` binds tighter than `/`, so a bare `a || b / 5` divides the text. */
const sessionIndex = `(${rowId} / ${TRACES_PER_SESSION})`;
const timestampSql = `strftime('%Y-%m-%d %H:%M:%f', @corpusStart, '+' || ((${rowId} * 7) % ${SPREAD_MINUTES}) || ' minutes')`;
const userIdSql = `CASE
          WHEN ${rowId} % 10 = 0 THEN NULL
          WHEN ${rowId} % 97 = 0 THEN 'scale,user,comma'
          ELSE 'scale-user-' || (${rowId} % 7)
        END`;
const tagsSql = `CASE
          WHEN ${rowId} % 4 = 0 THEN '[]'
          WHEN ${rowId} % 3 = 0 THEN json_array('scale-alpha', 'scale-beta')
          ELSE json_array('scale-alpha')
        END`;
const environmentSql = `CASE
          WHEN ${rowId} % 5 = 0 THEN 'production'
          WHEN ${rowId} % 7 = 0 THEN 'staging'
          ELSE 'default'
        END`;
/** Same two soft-deleted traces as the 1k corpus ('…-1' in session 0, '…-11' in session 2). */
const isDeletedSql = `CASE WHEN ${rowId} IN (1, 11) THEN 1 ELSE 0 END`;
/** Metrics are missing for every 10th trace and for all of session 2. */
const hasMetricsSql = `(${rowId} % 10 != 9 AND ${sessionIndex} != 2)`;

const sequenceCte = `WITH RECURSIVE seq(n) AS (
          SELECT 0
          UNION ALL
          SELECT n + 1 FROM seq WHERE n + 1 < @rows
        )`;

const TRACE_INSERT_SQL = `
        INSERT INTO traces (
          id, project_id, session_id, user_id, timestamp, tags, environment,
          is_deleted, created_at, updated_at, event_ts
        )
        ${sequenceCte}
        SELECT 'scale-trace-' || ${rowId},
               @projectId,
               'scale-session-' || ${sessionIndex},
               ${userIdSql},
               ${timestampSql}, ${tagsSql}, ${environmentSql}, ${isDeletedSql},
               ${timestampSql}, ${timestampSql}, ${timestampSql}
        FROM seq`;

const METRIC_INSERT_SQL = `
        INSERT INTO trace_metrics (
          project_id, trace_id, user_id, session_id, obs_count,
          input_cost, output_cost, total_cost,
          input_tokens, output_tokens, total_tokens, cached_tokens,
          cache_creation_tokens, gross_input_tokens, timestamp
        )
        ${sequenceCte}
        SELECT @projectId,
               'scale-trace-' || ${rowId},
               ${userIdSql},
               'scale-session-' || ${sessionIndex},
               1,
               0.001 * (${rowId} % 5), 0.002, 0.001 * (${rowId} % 5) + 0.002,
               10 + (${rowId} % 50), 5 + (${rowId} % 20),
               10 + (${rowId} % 50) + 5 + (${rowId} % 20),
               CASE WHEN ${rowId} % 3 = 0 THEN 3 ELSE 0 END,
               0, 0,
               ${timestampSql}
        FROM seq
        WHERE ${hasMetricsSql}`;

/** Number of traces the loader gives a `trace_metrics` row. */
export function expectedMetricCount(traceCount: number): number {
  let count = 0;
  for (let index = 0; index < traceCount; index++) {
    const session = Math.floor(index / TRACES_PER_SESSION);
    if (index % 10 !== 9 && session !== 2) count++;
  }
  return count;
}

/**
 * Seeds `traceCount` traces (+ their metrics) into a fresh project and runs one
 * `ANALYZE` so the route plans against real `sqlite_stat1` statistics. Counts
 * are verified afterwards; a shortfall throws instead of silently benchmarking a
 * smaller corpus.
 */
export async function seedScaleCorpus(traceCount: number): Promise<ScaleCorpus> {
  if (!Number.isInteger(traceCount) || traceCount < 1)
    throw new Error(`invalid scale corpus size: ${traceCount}`);
  const project = await createSecondProject();
  const projectId = project.projectId;
  const db = getTelemetryDB();
  const started = performance.now();
  const insertChunks = async (query: string, size: number): Promise<void> => {
    for (let start = 0; start < traceCount; start += size) {
      await db.command({
        query,
        params: {
          projectId,
          corpusStart: CORPUS_START,
          start,
          rows: Math.min(size, traceCount - start),
        },
      });
    }
  };
  await insertChunks(TRACE_INSERT_SQL, TRACE_CHUNK_ROWS);
  await insertChunks(METRIC_INSERT_SQL, METRIC_CHUNK_ROWS);

  const countOf = async (table: string): Promise<number> => {
    const rows = await db.query<{ count: number }>({
      query: `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = @projectId`,
      params: { projectId },
    });
    return Number(rows[0]?.count ?? 0);
  };
  const metricCount = await countOf("trace_metrics");
  const traces = await countOf("traces");
  // Verify the derived session grouping too: the trace and metric counts alone
  // would not catch a session id expression that collapses every row into one
  // session (the `||` / `/` precedence trap).
  const sessionRows = await db.query<{ count: number }>({
    query: "SELECT COUNT(DISTINCT session_id) AS count FROM traces WHERE project_id = @projectId",
    params: { projectId },
  });
  const sessions = Number(sessionRows[0]?.count ?? 0);
  const expectedMetrics = expectedMetricCount(traceCount);
  const expectedSessions = Math.ceil(traceCount / TRACES_PER_SESSION);
  if (traces !== traceCount || metricCount !== expectedMetrics || sessions !== expectedSessions)
    throw new Error(
      `scale corpus mismatch: expected ${traceCount}/${expectedMetrics}/${expectedSessions} traces/metrics/sessions, got ${traces}/${metricCount}/${sessions}`,
    );

  // The route renders `createdAt` with `String(value).replace(" ", "T") + "Z"`,
  // so an unparseable timestamp would silently produce an invalid API date.
  const sample = await db.query<{ timestamp: string }>({
    query: "SELECT timestamp FROM traces WHERE project_id = @projectId ORDER BY id LIMIT 1",
    params: { projectId },
  });
  const rawTimestamp = sample[0]?.timestamp ?? "";
  if (Number.isNaN(Date.parse(`${rawTimestamp.replace(" ", "T")}Z`)))
    throw new Error(`scale corpus produced an unparseable timestamp: ${rawTimestamp}`);

  const seedMs = performance.now() - started;
  const analyzeStarted = performance.now();
  await db.command({ query: "ANALYZE", params: {} });
  return {
    projectId,
    auth: project.auth,
    traceCount: traces,
    metricCount,
    sessionCount: sessions,
    seedMs,
    analyzeMs: performance.now() - analyzeStarted,
  };
}
