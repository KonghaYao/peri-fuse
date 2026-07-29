/**
 * Thin typed REST client for the lite-server public API.
 *
 * Talks to the same `/api/public/*` endpoints the Langfuse SDK uses, with HTTP
 * Basic auth (`publicKey:secretKey`). Requests go to a same-origin relative
 * path by default (works behind the lite-server's static hosting and the Vite
 * dev proxy); an optional `baseUrl` from the auth store overrides this.
 */
import { getAuthConfig } from "@/store/auth";
import type {
  Dashboard,
  Observation,
  ObservationListParams,
  Paged,
  Score,
  ScoreListParams,
  SessionDetail,
  SessionListParams,
  SessionRow,
  Trace,
  TraceListParams,
  TraceMetrics,
  TraceWithDetails,
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
  const { baseUrl, publicKey, secretKey } = getAuthConfig();
  const url = `${baseUrl}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: basicAuthHeader(publicKey, secretKey),
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    throw new ApiError(
      0,
      `Network error reaching lite-server at ${baseUrl || "same origin"}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
  // Health does not require auth; hit it to verify connectivity/baseUrl.
  const { baseUrl } = getAuthConfig();
  return fetch(`${baseUrl}/api/public/health`).then(async (res) => {
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

export function getDashboard(): Promise<Dashboard> {
  return request<Dashboard>(`/api/public/dashboard`);
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
