/**
 * Centralized React Query layer.
 *
 * All query keys and query functions live here so pages stay thin and
 * cache behaviour is consistent. Management-API hooks (projects, keys)
 * replace the manual fetch + useState patterns that settings/onboarding
 * previously used.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  activateProject,
  createProject,
  createProjectKey,
  deleteProjectKey,
  getDashboard,
  getSession,
  getTrace,
  getTracesMetrics,
  listObservations,
  listProjectKeys,
  listProjects,
  listScores,
  listSessions,
  listTraces,
  listUsers,
} from "@/shared/lib/api";
import type {
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
  sessions: (params: SessionListParams) => ["sessions", params] as const,
  session: (id: string) => ["session", id] as const,
  users: (params: UserListParams) => ["users", params] as const,
  observations: (params: ObservationListParams) => ["observations", params] as const,
  scores: (params: ScoreListParams) => ["scores", params] as const,
  dashboard: ["dashboard"] as const,
  projects: ["projects"] as const,
  projectKeys: (projectId: string) => ["project-keys", projectId] as const,
};

// ---------------------------------------------------------------------------
// Data queries (public API)
// ---------------------------------------------------------------------------

export function useTracesQuery(params: TraceListParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: queryKeys.traces(params),
    queryFn: () => listTraces(params),
    placeholderData: keepPreviousData,
    refetchInterval: refetchInterval || false,
  });
}

export function useTracesMetricsQuery(traceIds: string[]) {
  const refetchInterval = useRefreshInterval();
  const idsKey = traceIds.join(",");
  return useQuery({
    queryKey: queryKeys.tracesMetrics(idsKey),
    queryFn: () => getTracesMetrics(traceIds),
    enabled: traceIds.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: refetchInterval || false,
  });
}

export function useTraceQuery(traceId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.trace(traceId ?? ""),
    queryFn: () => getTrace(traceId!),
    enabled: Boolean(traceId),
  });
}

export function useSessionsQuery(params: SessionListParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: queryKeys.sessions(params),
    queryFn: () => listSessions(params),
    placeholderData: keepPreviousData,
    refetchInterval: refetchInterval || false,
  });
}

export function useSessionQuery(sessionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.session(sessionId ?? ""),
    queryFn: () => getSession(sessionId!),
    enabled: Boolean(sessionId),
  });
}

export function useUsersQuery(params: UserListParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: queryKeys.users(params),
    queryFn: () => listUsers(params),
    placeholderData: keepPreviousData,
    refetchInterval: refetchInterval || false,
  });
}

export function useObservationsQuery(params: ObservationListParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: queryKeys.observations(params),
    queryFn: () => listObservations(params),
    placeholderData: keepPreviousData,
    refetchInterval: refetchInterval || false,
  });
}

export function useScoresQuery(params: ScoreListParams) {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: queryKeys.scores(params),
    queryFn: () => listScores(params),
    placeholderData: keepPreviousData,
    refetchInterval: refetchInterval || false,
  });
}

export function useDashboardQuery() {
  const refetchInterval = useRefreshInterval();
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: getDashboard,
    refetchInterval: refetchInterval || false,
  });
}

// ---------------------------------------------------------------------------
// Management queries & mutations
// ---------------------------------------------------------------------------

export function useProjectsQuery() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: listProjects,
  });
}

export function useProjectKeysQuery(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.projectKeys(projectId ?? ""),
    queryFn: () => listProjectKeys(projectId!),
    enabled: Boolean(projectId),
  });
}

export function useCreateProjectMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createProject(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

export function useActivateProjectMutation() {
  return useMutation({
    mutationFn: (projectId: string) => activateProject(projectId),
  });
}

export function useCreateKeyMutation(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => createProjectKey(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projectKeys(projectId) }),
  });
}

export function useDeleteKeyMutation(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => deleteProjectKey(keyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projectKeys(projectId) }),
  });
}
