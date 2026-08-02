/**
 * Thin typed REST client for the Peri-Fuse server API.
 *
 * Data endpoints (`/api/public/*`) use HTTP Basic auth with the active
 * project's publicKey:secretKey. Management endpoints (`/api/manage/*`)
 * require no auth (local server).
 */

import type { ProjectContext } from "@/shared/store/project";
import { getProjectContext } from "@/shared/store/project";
import type {
  CreatedKey,
  Dashboard,
  DashboardQueryParams,
  Observation,
  ObservationListParams,
  Paged,
  Project,
  ProjectKey,
  Score,
  ScoreListParams,
  SessionDetail,
  SessionListParams,
  SessionRow,
  Trace,
  TraceListParams,
  TraceMetrics,
  TraceWithDetails,
  UserListParams,
  UserRow,
} from "./types";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function basicAuthHeader(publicKey: string, secretKey: string): string {
  // Base64-encode the `publicKey:secretKey` pair. Keys are ASCII in practice,
  // but we encode via TextEncoder to stay safe for any edge characters.
  const raw = `${publicKey}:${secretKey}`;
  const bytes = new TextEncoder().encode(raw);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** Build a query string from a params object, dropping null/undefined/"". */
function toQueryString(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const v of value) sp.append(key, String(v));
    } else {
      sp.set(key, String(value));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function request<T>(path: string): Promise<T> {
  const ctx = getProjectContext();
  if (!ctx) throw new ApiError(0, "No active project");

  let res: Response;
  try {
    res = await fetch(path, {
      method: "GET",
      headers: {
        Authorization: basicAuthHeader(ctx.publicKey, ctx.secretKey),
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    throw new ApiError(0, `Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export function healthCheck(): Promise<{ status: string }> {
  return fetch("/api/public/health").then(async (res) => {
    if (!res.ok) throw new ApiError(res.status, `Health check failed (${res.status})`);
    return (await res.json()) as { status: string };
  });
}

export function listTraces(params: TraceListParams = {}): Promise<Paged<Trace>> {
  return request<Paged<Trace>>(`/api/public/traces${toQueryString({ ...params })}`);
}

export function getTrace(traceId: string): Promise<TraceWithDetails> {
  return request<TraceWithDetails>(`/api/public/traces/${encodeURIComponent(traceId)}`);
}

export function listObservations(params: ObservationListParams = {}): Promise<Paged<Observation>> {
  return request<Paged<Observation>>(`/api/public/observations${toQueryString({ ...params })}`);
}

export function listScores(params: ScoreListParams = {}): Promise<Paged<Score>> {
  return request<Paged<Score>>(`/api/public/scores${toQueryString({ ...params })}`);
}

export function getDashboard(params: DashboardQueryParams = {}): Promise<Dashboard> {
  return request<Dashboard>(`/api/public/dashboard${toQueryString({ ...params })}`);
}

export function getTracesMetrics(traceIds: string[]): Promise<TraceMetrics[]> {
  if (traceIds.length === 0) return Promise.resolve([]);
  return request<TraceMetrics[]>(
    `/api/public/traces/metrics${toQueryString({ traceIds: traceIds.join(",") })}`,
  );
}

export function listSessions(params: SessionListParams = {}): Promise<Paged<SessionRow>> {
  return request<Paged<SessionRow>>(`/api/public/sessions${toQueryString({ ...params })}`);
}

export function getSession(sessionId: string): Promise<SessionDetail> {
  return request<SessionDetail>(`/api/public/sessions/${encodeURIComponent(sessionId)}`);
}

export function listUsers(params: UserListParams = {}): Promise<Paged<UserRow>> {
  return request<Paged<UserRow>>(`/api/public/users${toQueryString({ ...params })}`);
}

// ---------------------------------------------------------------------------
// Management API (no Basic auth required)
// ---------------------------------------------------------------------------

async function manageRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      message = body.message ?? message;
    } catch {
      // non-JSON
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export function listProjects(): Promise<Project[]> {
  return manageRequest<Project[]>("/api/manage/projects");
}

export function createProject(name: string): Promise<Project> {
  return manageRequest<Project>("/api/manage/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function listProjectKeys(projectId: string): Promise<ProjectKey[]> {
  return manageRequest<ProjectKey[]>(`/api/manage/projects/${encodeURIComponent(projectId)}/keys`);
}

export function createProjectKey(projectId: string): Promise<CreatedKey> {
  return manageRequest<CreatedKey>(`/api/manage/projects/${encodeURIComponent(projectId)}/keys`, {
    method: "POST",
  });
}

export function deleteProjectKey(keyId: string): Promise<void> {
  return manageRequest<void>(`/api/manage/keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
  });
}

export function activateProject(projectId: string): Promise<ProjectContext> {
  return manageRequest<ProjectContext>(
    `/api/manage/projects/${encodeURIComponent(projectId)}/activate`,
    { method: "POST" },
  );
}
