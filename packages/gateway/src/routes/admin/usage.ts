/**
 * Admin API — Usage statistics queries (project-scoped).
 */

import { and, desc, eq, gte, lte, type SQL, sum } from "drizzle-orm";
import { Hono } from "hono";
import type { GatewayEnv } from "../../app.js";
import { dailySpend } from "../../db/schema.js";
import { getDb } from "../../db.js";

const usage = new Hono<GatewayEnv>();
const MAX_DAILY_USAGE_LIMIT = 200;

interface DailyUsageQuery {
  startDate?: string;
  endDate?: string;
  apiKey?: string;
  model?: string;
  provider?: string;
  limit: number;
}

function parseDailyLimit(value: string | undefined): number | null {
  if (value === undefined) return 100;
  if (!/^[1-9]\d*$/.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_DAILY_USAGE_LIMIT ? parsed : null;
}

function isStrictUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseDailyUsageQuery(
  raw: Record<string, string>,
): { ok: true; value: DailyUsageQuery } | { ok: false; message: string } {
  const limit = parseDailyLimit(raw.limit);
  if (limit === null) {
    return { ok: false, message: "limit must be an integer between 1 and 200" };
  }

  if (raw.startDate !== undefined && !isStrictUtcDate(raw.startDate)) {
    return { ok: false, message: "startDate must be a valid date in YYYY-MM-DD format" };
  }
  if (raw.endDate !== undefined && !isStrictUtcDate(raw.endDate)) {
    return { ok: false, message: "endDate must be a valid date in YYYY-MM-DD format" };
  }
  if (raw.startDate !== undefined && raw.endDate !== undefined && raw.startDate > raw.endDate) {
    return { ok: false, message: "startDate must be on or before endDate" };
  }

  return {
    ok: true,
    value: {
      startDate: raw.startDate,
      endDate: raw.endDate,
      apiKey: raw.apiKey || undefined,
      model: raw.model || undefined,
      provider: raw.provider || undefined,
      limit,
    },
  };
}

// Get daily spend summary with optional filters
usage.get("/daily", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const parsed = parseDailyUsageQuery(c.req.query());

  if (!parsed.ok) {
    return c.json({ error: { message: parsed.message } }, 400);
  }
  const { startDate, endDate, apiKey, model, provider, limit } = parsed.value;

  const conditions: SQL[] = [eq(dailySpend.projectId, projectId)];
  if (startDate) conditions.push(gte(dailySpend.date, startDate));
  if (endDate) conditions.push(lte(dailySpend.date, endDate));
  if (apiKey) conditions.push(eq(dailySpend.apiKey, apiKey));
  if (model) conditions.push(eq(dailySpend.model, model));
  if (provider) conditions.push(eq(dailySpend.provider, provider));
  const where = and(...conditions);

  const items = await db
    .select()
    .from(dailySpend)
    .where(where)
    .orderBy(desc(dailySpend.date))
    .limit(limit);

  return c.json({ data: items });
});

// Get aggregated totals
usage.get("/summary", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const { startDate, endDate, apiKey } = c.req.query();

  const conditions: SQL[] = [eq(dailySpend.projectId, projectId)];
  if (startDate) conditions.push(gte(dailySpend.date, startDate));
  if (endDate) conditions.push(lte(dailySpend.date, endDate));
  if (apiKey) conditions.push(eq(dailySpend.apiKey, apiKey));
  const where = and(...conditions);

  const [result] = await db
    .select({
      spend: sum(dailySpend.spend),
      promptTokens: sum(dailySpend.promptTokens),
      completionTokens: sum(dailySpend.completionTokens),
      apiRequests: sum(dailySpend.apiRequests),
      successfulRequests: sum(dailySpend.successfulRequests),
      failedRequests: sum(dailySpend.failedRequests),
    })
    .from(dailySpend)
    .where(where);

  return c.json({
    totalSpend: Number(result?.spend ?? 0),
    totalPromptTokens: Number(result?.promptTokens ?? 0),
    totalCompletionTokens: Number(result?.completionTokens ?? 0),
    totalRequests: Number(result?.apiRequests ?? 0),
    successfulRequests: Number(result?.successfulRequests ?? 0),
    failedRequests: Number(result?.failedRequests ?? 0),
  });
});

// Get per-model breakdown
usage.get("/by-model", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const { startDate, endDate } = c.req.query();

  const conditions: SQL[] = [eq(dailySpend.projectId, projectId)];
  if (startDate) conditions.push(gte(dailySpend.date, startDate));
  if (endDate) conditions.push(lte(dailySpend.date, endDate));
  const where = and(...conditions);

  const results = await db
    .select({
      model: dailySpend.model,
      modelGroup: dailySpend.modelGroup,
      spend: sum(dailySpend.spend),
      promptTokens: sum(dailySpend.promptTokens),
      completionTokens: sum(dailySpend.completionTokens),
      apiRequests: sum(dailySpend.apiRequests),
    })
    .from(dailySpend)
    .where(where)
    .groupBy(dailySpend.model, dailySpend.modelGroup);

  return c.json({
    data: results.map((r) => ({
      model: r.model,
      modelGroup: r.modelGroup,
      totalSpend: Number(r.spend ?? 0),
      totalPromptTokens: Number(r.promptTokens ?? 0),
      totalCompletionTokens: Number(r.completionTokens ?? 0),
      totalRequests: Number(r.apiRequests ?? 0),
    })),
  });
});

// Get per-provider breakdown
usage.get("/by-provider", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const { startDate, endDate } = c.req.query();

  const conditions: SQL[] = [eq(dailySpend.projectId, projectId)];
  if (startDate) conditions.push(gte(dailySpend.date, startDate));
  if (endDate) conditions.push(lte(dailySpend.date, endDate));
  const where = and(...conditions);

  const results = await db
    .select({
      provider: dailySpend.provider,
      spend: sum(dailySpend.spend),
      promptTokens: sum(dailySpend.promptTokens),
      completionTokens: sum(dailySpend.completionTokens),
      apiRequests: sum(dailySpend.apiRequests),
    })
    .from(dailySpend)
    .where(where)
    .groupBy(dailySpend.provider);

  return c.json({
    data: results.map((r) => ({
      provider: r.provider,
      totalSpend: Number(r.spend ?? 0),
      totalPromptTokens: Number(r.promptTokens ?? 0),
      totalCompletionTokens: Number(r.completionTokens ?? 0),
      totalRequests: Number(r.apiRequests ?? 0),
    })),
  });
});

// Get per-key breakdown
usage.get("/by-key", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const { startDate, endDate } = c.req.query();

  const conditions: SQL[] = [eq(dailySpend.projectId, projectId)];
  if (startDate) conditions.push(gte(dailySpend.date, startDate));
  if (endDate) conditions.push(lte(dailySpend.date, endDate));
  const where = and(...conditions);

  const results = await db
    .select({
      apiKey: dailySpend.apiKey,
      spend: sum(dailySpend.spend),
      apiRequests: sum(dailySpend.apiRequests),
    })
    .from(dailySpend)
    .where(where)
    .groupBy(dailySpend.apiKey);

  return c.json({
    data: results.map((r) => ({
      apiKey: r.apiKey,
      totalSpend: Number(r.spend ?? 0),
      totalRequests: Number(r.apiRequests ?? 0),
    })),
  });
});

export default usage;
