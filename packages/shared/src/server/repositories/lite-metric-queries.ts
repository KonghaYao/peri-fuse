import { getTelemetryDB } from "../adapters";
import { logger } from "../logger";
/**
 * Get trace metrics (simplified for lite mode).
 */
export async function liteGetTracesTableMetrics(
  projectId: string,
  traceIds: string[],
): Promise<
  Array<{
    id: string;
    projectId: string;
    promptTokens: bigint;
    completionTokens: bigint;
    totalTokens: bigint;
    latency: number | null;
    level: string;
    observationCount: bigint;
    calculatedTotalCost: number | null;
    calculatedInputCost: number | null;
    calculatedOutputCost: number | null;
    usageDetails: Record<string, number>;
    costDetails: Record<string, number>;
    errorCount: bigint;
    warningCount: bigint;
    defaultCount: bigint;
    debugCount: bigint;
  }>
> {
  if (traceIds.length === 0) return [];
  const db = getTelemetryDB();

  try {
    // Get observation stats per trace
    const placeholders = traceIds.map((_, i) => `@id${i}`).join(",");
    const params: Record<string, unknown> = { projectId };
    traceIds.forEach((id, i) => {
      params[`id${i}`] = id;
    });

    const obsStats = await db.query<Record<string, unknown>>({
      query: `
        SELECT trace_id,
               COUNT(*) as obs_count,
               SUM(CASE WHEN level = 'ERROR' THEN 1 ELSE 0 END) as error_count,
               SUM(CASE WHEN level = 'WARNING' THEN 1 ELSE 0 END) as warning_count,
               SUM(CASE WHEN level = 'DEFAULT' THEN 1 ELSE 0 END) as default_count,
               SUM(CASE WHEN level = 'DEBUG' THEN 1 ELSE 0 END) as debug_count,
               SUM(total_cost) as total_cost,
               MIN(start_time) as min_start,
               MAX(COALESCE(end_time, start_time)) as max_end
        FROM observations
        WHERE project_id = @projectId AND trace_id IN (${placeholders}) AND is_deleted = 0
        GROUP BY trace_id
      `,
      params,
    });

    const statsMap = new Map<string, Record<string, unknown>>();
    for (const row of obsStats) {
      statsMap.set(String(row.trace_id), row);
    }

    return traceIds.map((traceId) => {
      const stats = statsMap.get(traceId);
      if (!stats) {
        return {
          id: traceId,
          projectId,
          promptTokens: BigInt(0),
          completionTokens: BigInt(0),
          totalTokens: BigInt(0),
          latency: null,
          level: "DEFAULT",
          observationCount: BigInt(0),
          calculatedTotalCost: null,
          calculatedInputCost: null,
          calculatedOutputCost: null,
          usageDetails: {},
          costDetails: {},
          errorCount: BigInt(0),
          warningCount: BigInt(0),
          defaultCount: BigInt(0),
          debugCount: BigInt(0),
        };
      }

      const minStart = stats.min_start
        ? new Date(`${String(stats.min_start).replace(" ", "T")}Z`).getTime()
        : null;
      const maxEnd = stats.max_end
        ? new Date(`${String(stats.max_end).replace(" ", "T")}Z`).getTime()
        : null;
      const latency = minStart !== null && maxEnd !== null ? (maxEnd - minStart) / 1000 : null;

      const errorCount = BigInt(Number(stats.error_count ?? 0));
      const warningCount = BigInt(Number(stats.warning_count ?? 0));

      return {
        id: traceId,
        projectId,
        promptTokens: BigInt(0),
        completionTokens: BigInt(0),
        totalTokens: BigInt(0),
        latency,
        level: errorCount > BigInt(0) ? "ERROR" : warningCount > BigInt(0) ? "WARNING" : "DEFAULT",
        observationCount: BigInt(Number(stats.obs_count ?? 0)),
        calculatedTotalCost: stats.total_cost ? Number(stats.total_cost) : null,
        calculatedInputCost: null,
        calculatedOutputCost: null,
        usageDetails: {},
        costDetails: {},
        errorCount,
        warningCount,
        defaultCount: BigInt(Number(stats.default_count ?? 0)),
        debugCount: BigInt(Number(stats.debug_count ?? 0)),
      };
    });
  } catch (error) {
    logger.error("[liteGetTracesTableMetrics] Query failed", error);
    return traceIds.map((traceId) => ({
      id: traceId,
      projectId,
      promptTokens: BigInt(0),
      completionTokens: BigInt(0),
      totalTokens: BigInt(0),
      latency: null,
      level: "DEFAULT",
      observationCount: BigInt(0),
      calculatedTotalCost: null,
      calculatedInputCost: null,
      calculatedOutputCost: null,
      usageDetails: {},
      costDetails: {},
      errorCount: BigInt(0),
      warningCount: BigInt(0),
      defaultCount: BigInt(0),
      debugCount: BigInt(0),
    }));
  }
}
