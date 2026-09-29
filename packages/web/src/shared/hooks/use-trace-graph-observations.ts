import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { isGraphSubagent } from "@/shared/components/observation-trace-graph-semantics";
import { queryKeys } from "@/shared/hooks/queries";
import { getObservationDetail, getObservationOutput } from "@/shared/lib/api";
import { getGenerationPreview } from "@/shared/lib/generation-preview";
import type { Observation } from "@/shared/lib/types";

/** Load only branch/launcher details: summaries omit the background execution flag. */
export function useTraceGraphObservations(
  traceId: string,
  observations: Observation[],
  enabled = true,
) {
  const client = useQueryClient();
  const branchIds = useMemo(() => {
    const byId = new Map(observations.map((observation) => [observation.id, observation]));
    const ids = new Set<string>();
    for (const observation of observations) {
      if (!isGraphSubagent(observation)) continue;
      ids.add(observation.id);
      const visited = new Set([observation.id]);
      let parentId = observation.parentObservationId;
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent || parent.type === "AGENT") break;
        if (parent.type === "TOOL") {
          ids.add(parent.id);
          break;
        }
        parentId = parent.parentObservationId;
      }
    }
    return [...ids].sort();
  }, [observations]);
  const query = useQuery({
    queryKey: ["trace-graph-branches", traceId, branchIds],
    enabled: enabled && branchIds.length > 0,
    queryFn: async () => {
      const details = new Map<string, Observation>();
      const failures: { id: string; error: unknown }[] = [];
      // Large traces must not fan out one concurrent request per branch.
      for (let offset = 0; offset < branchIds.length; offset += 4) {
        const ids = branchIds.slice(offset, offset + 4);
        const results = await Promise.allSettled(
          ids.map((id) =>
            client.fetchQuery({
              queryKey: queryKeys.observationDetail(id),
              queryFn: () => getObservationDetail(id),
              staleTime: 5_000,
            }),
          ),
        );
        results.forEach((result, index) => {
          if (result.status === "fulfilled") details.set(ids[index], result.value);
          else failures.push({ id: ids[index], error: result.reason });
        });
      }
      return { details, failures };
    },
  });
  const generationIds = useMemo(
    () =>
      observations
        .filter((o) => o.type === "GENERATION" && o.output === undefined)
        .map((o) => o.id)
        .sort(),
    [observations],
  );
  const outputs = useQuery({
    queryKey: ["trace-graph-output-previews", traceId, generationIds],
    enabled: enabled && generationIds.length > 0,
    queryFn: async () => {
      const previews = new Map<string, string>();
      const failures: { id: string; error: unknown }[] = [];
      for (let offset = 0; offset < generationIds.length; offset += 4) {
        const ids = generationIds.slice(offset, offset + 4);
        const results = await Promise.allSettled(
          ids.map((id) =>
            client.fetchQuery({
              queryKey: ["observation-output-preview", id],
              // Cache a small excerpt, not every model's complete answer.
              queryFn: async () => getGenerationPreview(await getObservationOutput(id), 300) ?? "",
              staleTime: 5_000,
            }),
          ),
        );
        results.forEach((result, index) => {
          if (result.status === "fulfilled") previews.set(ids[index], result.value);
          else failures.push({ id: ids[index], error: result.reason });
        });
      }
      return { previews, failures };
    },
  });
  return {
    observations: observations.map((observation) => {
      const detail = query.data?.details.get(observation.id) ?? observation;
      const preview = outputs.data?.previews.get(observation.id);
      return preview !== undefined && detail.output === undefined
        ? { ...detail, output: preview }
        : detail;
    }),
    isLoading: query.isFetching || outputs.isFetching,
    failures: query.data?.failures ?? [],
    outputFailures: outputs.data?.failures ?? [],
    retry: () => Promise.all([query.refetch(), outputs.refetch()]),
  };
}
