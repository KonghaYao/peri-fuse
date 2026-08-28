/**
 * Typed REST client for the PeriGateway Admin API.
 *
 * All requests go through the server proxy at `/api/gateway/*`, which applies
 * the gateway's unifiedAuth and resolves the project-scoped projectId. The
 * active project's publicKey:secretKey is sent via HTTP Basic auth so the
 * gateway data stays isolated per project.
 */

import { clearProjectContext, getProjectContext } from "@/shared/store/project";
import { ApiError } from "./api";

function basicAuthHeader(publicKey: string, secretKey: string): string {
  const raw = `${publicKey}:${secretKey}`;
  const bytes = new TextEncoder().encode(raw);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

async function gatewayRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const ctx = getProjectContext();
  if (!ctx) throw new ApiError(0, "No active project");

  let res: Response;
  try {
    res = await fetch(`/api/gateway${path}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: basicAuthHeader(ctx.publicKey, ctx.secretKey),
      },
      ...init,
    });
  } catch (err) {
    throw new ApiError(0, `Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string }; message?: string };
      message = body.error?.message ?? body.message ?? message;
    } catch {
      // non-JSON error body
    }
    // Same recovery as api.ts: stale credentials bounce to project selection.
    if (res.status === 401) clearProjectContext();
    throw new ApiError(res.status, message);
  }

  return (await res.json()) as T;
}

function toQueryString(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatewayProvider {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  isEnabled: boolean;
  status: string;
  cooldownUntil: string | null;
  budgetLimit: number | null;
  budgetPeriod: string | null;
  budgetSpend: number;
  budgetResetAt: string | null;
  deploymentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelDeployment {
  id: string;
  modelName: string;
  providerId: string;
  providerModel: string;
  litellmParams: Record<string, unknown>;
  modelInfo: { inputPrice?: number; outputPrice?: number } | null;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  provider: {
    id: string;
    name: string;
    type: string;
    isEnabled: boolean;
    status: string;
  } | null;
}

export interface UsageSummary {
  totalSpend: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
}

export interface DailySpendRow {
  id: string;
  date: string;
  apiKey: string;
  model: string;
  modelGroup: string | null;
  provider: string;
  spend: number;
  promptTokens: number;
  completionTokens: number;
  apiRequests: number;
  successfulRequests: number;
  failedRequests: number;
}

export interface UsageByModelRow {
  model: string;
  modelGroup: string | null;
  totalSpend: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalRequests: number;
}

export interface UsageByProviderRow {
  provider: string;
  totalSpend: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalRequests: number;
}

export interface RequestLog {
  id: string;
  callType: string;
  apiKey: string;
  model: string;
  modelGroup: string | null;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  spend: number;
  status: string;
  startTime: string;
  endTime: string | null;
  ttftMs: number | null;
  metadata: Record<string, unknown>;
  requestTags: string[];
  messages: unknown;
  response: unknown;
  sessionId: string | null;
}

export interface ErrorLog {
  id: string;
  modelGroup: string | null;
  provider: string;
  exceptionType: string;
  exceptionMessage: string;
  requestKwargs: Record<string, unknown>;
  startTime: string;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  tableName: string;
  objectId: string;
  beforeValue: string | null;
  afterValue: string | null;
  changedBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export function gwListProviders(): Promise<{ data: GatewayProvider[] }> {
  return gatewayRequest("/providers");
}

export function gwCreateProvider(body: {
  name: string;
  type: string;
  baseUrl: string;
  apiKey?: string;
  isEnabled?: boolean;
  budgetLimit?: number | null;
  budgetPeriod?: string | null;
}): Promise<GatewayProvider> {
  return gatewayRequest("/providers", { method: "POST", body: JSON.stringify(body) });
}

export function gwUpdateProvider(
  id: string,
  body: Partial<{
    name: string;
    type: string;
    baseUrl: string;
    apiKey: string;
    isEnabled: boolean;
    status: string;
    budgetLimit: number | null;
    budgetPeriod: string | null;
  }>,
): Promise<GatewayProvider> {
  return gatewayRequest(`/providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function gwDeleteProvider(id: string): Promise<{ success: boolean }> {
  return gatewayRequest(`/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export function gwListModels(): Promise<{ data: ModelDeployment[] }> {
  return gatewayRequest("/models");
}

export function gwCreateModel(body: {
  modelName: string;
  providerId: string;
  providerModel: string;
  modelInfo?: { inputPrice?: number; outputPrice?: number } | null;
  isEnabled?: boolean;
}): Promise<ModelDeployment> {
  return gatewayRequest("/models", { method: "POST", body: JSON.stringify(body) });
}

export function gwUpdateModel(
  id: string,
  body: Partial<{
    modelName: string;
    providerModel: string;
    providerId: string;
    modelInfo: { inputPrice?: number; outputPrice?: number } | null;
    isEnabled: boolean;
  }>,
): Promise<ModelDeployment> {
  return gatewayRequest(`/models/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function gwDeleteModel(id: string): Promise<{ success: boolean }> {
  return gatewayRequest(`/models/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function gwUsageSummary(params: {
  startDate?: string;
  endDate?: string;
}): Promise<UsageSummary> {
  return gatewayRequest(`/usage/summary${toQueryString(params)}`);
}

export function gwUsageDaily(params: {
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<{ data: DailySpendRow[] }> {
  return gatewayRequest(`/usage/daily${toQueryString(params)}`);
}

export function gwUsageByModel(params: {
  startDate?: string;
  endDate?: string;
}): Promise<{ data: UsageByModelRow[] }> {
  return gatewayRequest(`/usage/by-model${toQueryString(params)}`);
}

export function gwUsageByProvider(params: {
  startDate?: string;
  endDate?: string;
}): Promise<{ data: UsageByProviderRow[] }> {
  return gatewayRequest(`/usage/by-provider${toQueryString(params)}`);
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function gwRequestLogs(params: {
  model?: string;
  provider?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: RequestLog[]; total: number }> {
  return gatewayRequest(`/logs/requests${toQueryString(params)}`);
}

export function gwErrorLogs(params: {
  modelGroup?: string;
  exceptionType?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: ErrorLog[]; total: number }> {
  return gatewayRequest(`/logs/errors${toQueryString(params)}`);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function gwAuditLogs(params: {
  tableName?: string;
  limit?: number;
}): Promise<{ data: AuditLogEntry[] }> {
  return gatewayRequest(`/audit${toQueryString(params)}`);
}
