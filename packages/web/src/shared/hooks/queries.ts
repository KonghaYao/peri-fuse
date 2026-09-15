/**
 * Centralized TanStack Solid Query layer.
 *
 * All query keys and query functions live here so pages stay thin and
 * cache behaviour is consistent across observability and management flows.
 */

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/solid-query";
import {
  activateProject,
  createProject,
  createProjectKey,
  deleteProjectKey,
  getDashboard,
  getObservationDetail,
  getSession,
  getTraceIo,
  getTraceShell,
  getTracesMetrics,
  listErrors,
  listObservations,
  listProjectKeys,
  listProjects,
  listScores,
  listSessions,
  listTraceObservationSummaries,
  listTraces,
  listUsers,
} from "@/shared/lib/api";
import type {
  DashboardQueryParams,
  ErrorQueryParams,
  ObservationListParams,
  ScoreListParams,
  SessionListParams,
  TraceListParams,
  UserListParams,
} from "@/shared/lib/types";
import { useRefreshInterval } from "@/shared/store/auto-refresh";

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

export const queryKeys = {
  traces: (params: TraceListParams) => ["traces", params] as const,
  tracesMetrics: (ids: string) => ["traces-metrics", ids] as const,
  trace: (id: string) => ["trace", id] as const,
  traceIo: (id: string) => ["trace-io", id] as const,
  traceObservations: (id: string) => ["trace-observations", id] as const,
  observationDetail: (id: string) => ["observation-detail", id] as const,
  sessions: (params: SessionListParams) => ["sessions", params] as const,
  session: (id: string) => ["session", id] as const,
  users: (params: UserListParams) => ["users", params] as const,
  observations: (params: ObservationListParams) => ["observations", params] as const,
  scores: (params: ScoreListParams) => ["scores", params] as const,
  dashboard: (params?: DashboardQueryParams) => ["dashboard", params ?? {}] as const,
  errors: (params: ErrorQueryParams) => ["errors", params] as const,
  projects: ["projects"] as const,
  projectKeys: (projectId: string) => ["project-keys", projectId] as const,
};

// ---------------------------------------------------------------------------
// Data queries (public API)
// ---------------------------------------------------------------------------

export function useTracesQuery(getParams: () => TraceListParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery(() => {
    const params = getParams();
    return {
      queryKey: queryKeys.traces(params),
      queryFn: () => listTraces(params),
      placeholderData: keepPreviousData,
      refetchInterval: refetchInterval() || false,
    };
  });
}

export function useTracesMetricsQuery(getTraceIds: () => string[]) {
  const refetchInterval = useRefreshInterval();
  return useQuery(() => {
    const traceIds = getTraceIds();
    const idsKey = traceIds.join(",");
    return {
      queryKey: queryKeys.tracesMetrics(idsKey),
      queryFn: () => getTracesMetrics(traceIds),
      enabled: traceIds.length > 0,
      placeholderData: keepPreviousData,
      refetchInterval: refetchInterval() || false,
    };
  });
}

export function useTraceQuery(traceId: string | undefined) {
  return useQuery(() => ({
    queryKey: queryKeys.trace(traceId ?? ""),
    queryFn: () => getTraceShell(traceId!),
    enabled: Boolean(traceId),
  }));
}

export function useTraceIoQuery(traceId: string | undefined, getEnabled: () => boolean) {
  return useQuery(() => ({
    queryKey: queryKeys.traceIo(traceId ?? ""),
    queryFn: () => getTraceIo(traceId!),
    enabled: Boolean(traceId) && getEnabled(),
  }));
}

export function useTraceObservationsQuery(traceId: string | undefined, enabled = true) {
  return useInfiniteQuery(() => ({
    queryKey: queryKeys.traceObservations(traceId ?? ""),
    queryFn: ({ pageParam }) => listTraceObservationSummaries(traceId!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.meta.cursor ?? undefined,
    enabled: Boolean(traceId) && enabled,
  }));
}

export function useObservationDetailQuery(
  getObservationId: () => string | null | undefined,
) {
  return useQuery(() => {
    const observationId = getObservationId();
    return {
      queryKey: queryKeys.observationDetail(observationId ?? ""),
      queryFn: () => getObservationDetail(observationId!),
      enabled: Boolean(observationId),
    };
  });
}

export function useSessionsQuery(getParams: () => SessionListParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery(() => {
    const params = getParams();
    return {
      queryKey: queryKeys.sessions(params),
      queryFn: () => listSessions(params),
      placeholderData: keepPreviousData,
      refetchInterval: refetchInterval() || false,
    };
  });
}

export function useSessionQuery(sessionId: string | undefined) {
  return useQuery(() => ({
    queryKey: queryKeys.session(sessionId ?? ""),
    queryFn: () => getSession(sessionId!),
    enabled: Boolean(sessionId),
  }));
}

export function useUsersQuery(getParams: () => UserListParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery(() => {
    const params = getParams();
    return {
      queryKey: queryKeys.users(params),
      queryFn: () => listUsers(params),
      placeholderData: keepPreviousData,
      refetchInterval: refetchInterval() || false,
    };
  });
}

export function useObservationsQuery(getParams: () => ObservationListParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery(() => {
    const params = getParams();
    return {
      queryKey: queryKeys.observations(params),
      queryFn: () => listObservations(params),
      placeholderData: keepPreviousData,
      refetchInterval: refetchInterval() || false,
    };
  });
}

export function useScoresQuery(getParams: () => ScoreListParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery(() => {
    const params = getParams();
    return {
      queryKey: queryKeys.scores(params),
      queryFn: () => listScores(params),
      placeholderData: keepPreviousData,
      refetchInterval: refetchInterval() || false,
    };
  });
}

export function useDashboardQuery(params?: DashboardQueryParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery(() => ({
    queryKey: queryKeys.dashboard(params),
    queryFn: () => getDashboard(params),
    refetchInterval: refetchInterval() || false,
  }));
}

export function useErrorsQuery(getParams: () => ErrorQueryParams) {
  const refetchInterval = useRefreshInterval();
  return useInfiniteQuery(() => {
    const params = getParams();
    return {
      queryKey: queryKeys.errors(params),
      queryFn: ({ pageParam }) => listErrors(params, pageParam),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.meta.cursor ?? undefined,
      refetchInterval: refetchInterval() || false,
    };
  });
}

// ---------------------------------------------------------------------------
// Management queries & mutations
// ---------------------------------------------------------------------------

export function useProjectsQuery() {
  return useQuery(() => ({
    queryKey: queryKeys.projects,
    queryFn: listProjects,
  }));
}

export function useProjectKeysQuery(projectId: () => string | undefined) {
  return useQuery(() => ({
    queryKey: queryKeys.projectKeys(projectId() ?? ""),
    queryFn: () => listProjectKeys(projectId()!),
    enabled: Boolean(projectId()),
  }));
}

export function useCreateProjectMutation() {
  const qc = useQueryClient();
  return useMutation(() => ({
    mutationFn: (name: string) => createProject(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects }),
  }));
}

export function useActivateProjectMutation() {
  return useMutation(() => ({
    mutationFn: (projectId: string) => activateProject(projectId),
  }));
}

export function useCreateKeyMutation(projectId: () => string | undefined) {
  const qc = useQueryClient();
  return useMutation(() => ({
    mutationFn: () => createProjectKey(projectId()!),
    onSuccess: () => {
      const id = projectId();
      if (id) qc.invalidateQueries({ queryKey: queryKeys.projectKeys(id) });
    },
  }));
}

export function useDeleteKeyMutation(projectId: () => string | undefined) {
  const qc = useQueryClient();
  return useMutation(() => ({
    mutationFn: (keyId: string) => deleteProjectKey(keyId),
    onSuccess: () => {
      const id = projectId();
      if (id) qc.invalidateQueries({ queryKey: queryKeys.projectKeys(id) });
    },
  }));
}
