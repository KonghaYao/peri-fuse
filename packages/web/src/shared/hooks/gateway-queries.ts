/**
 * React Query hooks for the PeriGateway Admin API.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  gwAuditLogs,
  gwCreateKey,
  gwCreateModel,
  gwCreateProvider,
  gwDeleteKey,
  gwDeleteModel,
  gwDeleteProvider,
  gwErrorLogs,
  gwListKeys,
  gwListModels,
  gwListProviders,
  gwRequestLogs,
  gwUpdateKey,
  gwUpdateModel,
  gwUpdateProvider,
  gwUsageByModel,
  gwUsageByProvider,
  gwUsageDaily,
  gwUsageSummary,
} from "@/shared/lib/gateway-api";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const gwQueryKeys = {
  providers: ["gw-providers"] as const,
  models: ["gw-models"] as const,
  keys: ["gw-keys"] as const,
  usageSummary: (params: Record<string, string>) => ["gw-usage-summary", params] as const,
  usageDaily: (params: Record<string, string | number>) => ["gw-usage-daily", params] as const,
  usageByModel: (params: Record<string, string>) => ["gw-usage-by-model", params] as const,
  usageByProvider: (params: Record<string, string>) => ["gw-usage-by-provider", params] as const,
  requestLogs: (params: Record<string, string | number>) => ["gw-request-logs", params] as const,
  errorLogs: (params: Record<string, string | number>) => ["gw-error-logs", params] as const,
  auditLogs: (params: Record<string, string | number>) => ["gw-audit-logs", params] as const,
};

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export function useGwProvidersQuery() {
  return useQuery({
    queryKey: gwQueryKeys.providers,
    queryFn: () => gwListProviders().then((r) => r.data),
  });
}

export function useGwCreateProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: gwCreateProvider,
    onSuccess: () => qc.invalidateQueries({ queryKey: gwQueryKeys.providers }),
  });
}

export function useGwUpdateProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof gwUpdateProvider>[1] }) =>
      gwUpdateProvider(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: gwQueryKeys.providers }),
  });
}

export function useGwDeleteProviderMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: gwDeleteProvider,
    onSuccess: () => qc.invalidateQueries({ queryKey: gwQueryKeys.providers }),
  });
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export function useGwModelsQuery() {
  return useQuery({
    queryKey: gwQueryKeys.models,
    queryFn: () => gwListModels().then((r) => r.data),
  });
}

export function useGwCreateModelMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: gwCreateModel,
    onSuccess: () => qc.invalidateQueries({ queryKey: gwQueryKeys.models }),
  });
}

export function useGwUpdateModelMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof gwUpdateModel>[1] }) =>
      gwUpdateModel(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: gwQueryKeys.models }),
  });
}

export function useGwDeleteModelMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: gwDeleteModel,
    onSuccess: () => qc.invalidateQueries({ queryKey: gwQueryKeys.models }),
  });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export function useGwKeysQuery() {
  return useQuery({
    queryKey: gwQueryKeys.keys,
    queryFn: () => gwListKeys().then((r) => r.data),
  });
}

export function useGwCreateKeyMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: gwCreateKey,
    onSuccess: () => qc.invalidateQueries({ queryKey: gwQueryKeys.keys }),
  });
}

export function useGwUpdateKeyMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof gwUpdateKey>[1] }) =>
      gwUpdateKey(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: gwQueryKeys.keys }),
  });
}

export function useGwDeleteKeyMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: gwDeleteKey,
    onSuccess: () => qc.invalidateQueries({ queryKey: gwQueryKeys.keys }),
  });
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function useGwUsageSummaryQuery(params: { startDate: string; endDate: string }) {
  return useQuery({
    queryKey: gwQueryKeys.usageSummary(params),
    queryFn: () => gwUsageSummary(params),
  });
}

export function useGwUsageDailyQuery(params: { startDate: string; endDate: string }) {
  return useQuery({
    queryKey: gwQueryKeys.usageDaily(params),
    queryFn: () => gwUsageDaily({ ...params, limit: 200 }).then((r) => r.data),
  });
}

export function useGwUsageByModelQuery(params: { startDate: string; endDate: string }) {
  return useQuery({
    queryKey: gwQueryKeys.usageByModel(params),
    queryFn: () => gwUsageByModel(params).then((r) => r.data),
  });
}

export function useGwUsageByProviderQuery(params: { startDate: string; endDate: string }) {
  return useQuery({
    queryKey: gwQueryKeys.usageByProvider(params),
    queryFn: () => gwUsageByProvider(params).then((r) => r.data),
  });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function useGwRequestLogsQuery(params: {
  model?: string;
  provider?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: gwQueryKeys.requestLogs(params as Record<string, string | number>),
    queryFn: () => gwRequestLogs(params),
    placeholderData: (prev) => prev,
  });
}

export function useGwErrorLogsQuery(params: {
  modelGroup?: string;
  exceptionType?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: gwQueryKeys.errorLogs(params as Record<string, string | number>),
    queryFn: () => gwErrorLogs(params),
    placeholderData: (prev) => prev,
  });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function useGwAuditLogsQuery(params: { tableName?: string; limit?: number }) {
  return useQuery({
    queryKey: gwQueryKeys.auditLogs(params as Record<string, string | number>),
    queryFn: () => gwAuditLogs(params).then((r) => r.data),
  });
}
