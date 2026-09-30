import { useQuery } from "@tanstack/react-query";
import { gwQueryKeys } from "@/shared/hooks/gateway-queries";
import {
  gwErrorLogs,
  gwListModels,
  gwListProviders,
  gwRequestLogs,
  gwUsageByModel,
  gwUsageByProvider,
  gwUsageDaily,
  gwUsageSummary,
  type UsageFilters,
} from "@/shared/lib/gateway-api";
import { useProjectContext } from "@/shared/store/project";

export function useFilteredProviders(params: Parameters<typeof gwListProviders>[0]) {
  const project = useProjectContext();
  return useQuery({
    queryKey: [...gwQueryKeys.providers, project?.projectId, params],
    queryFn: () => gwListProviders(params).then((result) => result.data),
  });
}

export function useFilteredModels(params: Parameters<typeof gwListModels>[0]) {
  const project = useProjectContext();
  return useQuery({
    queryKey: [...gwQueryKeys.models, project?.projectId, params],
    queryFn: () => gwListModels(params).then((result) => result.data),
  });
}

export function useFilteredRequests(params: Parameters<typeof gwRequestLogs>[0], enabled = true) {
  const project = useProjectContext();
  return useQuery({
    queryKey: [
      ...gwQueryKeys.requestLogs(params as Record<string, string | number>),
      project?.projectId,
    ],
    queryFn: () => gwRequestLogs(params),
    enabled,
  });
}

export function useFilteredErrors(params: Parameters<typeof gwErrorLogs>[0]) {
  const project = useProjectContext();
  return useQuery({
    queryKey: [
      ...gwQueryKeys.errorLogs(params as Record<string, string | number>),
      project?.projectId,
    ],
    queryFn: () => gwErrorLogs(params),
  });
}

export function useFilteredUsage(params: UsageFilters) {
  const project = useProjectContext();
  const summaryQuery = useQuery({
    queryKey: ["gw-usage-summary", project?.projectId, params],
    queryFn: () => gwUsageSummary(params),
  });
  const dailyQuery = useQuery({
    queryKey: ["gw-usage-daily", project?.projectId, params],
    queryFn: () => gwUsageDaily({ ...params, limit: 200 }).then((result) => result.data),
  });
  const byModelQuery = useQuery({
    queryKey: ["gw-usage-by-model", project?.projectId, params],
    queryFn: () => gwUsageByModel(params).then((result) => result.data),
  });
  const byProviderQuery = useQuery({
    queryKey: ["gw-usage-by-provider", project?.projectId, params],
    queryFn: () => gwUsageByProvider(params).then((result) => result.data),
  });
  return { summaryQuery, dailyQuery, byModelQuery, byProviderQuery };
}
