/**
 * Admin API — Usage statistics queries.
 */
import { Hono } from "hono";
import { and, desc, eq, gte, lte, sum, type SQL } from "drizzle-orm";
import { getDb } from "../../db.js";
import { dailySpend } from "../../db/schema.js";

const usage = new Hono();

// Get daily spend summary with optional filters
usage.get("/daily", async (c) => {
  const db = getDb();
  const { startDate, endDate, apiKey, model, provider, limit } = c.req.query();

  const conditions: SQL[] = [];
  if (startDate) conditions.push(gte(dailySpend.date, startDate));
  if (endDate) conditions.push(lte(dailySpend.date, endDate));
  if (apiKey) conditions.push(eq(dailySpend.apiKey, apiKey));
  if (model) conditions.push(eq(dailySpend.model, model));
  if (provider) conditions.push(eq(dailySpend.provider, provider));
  const where = conditions.length ? and(...conditions) : undefined;

  const items = await db
    .select()
    .from(dailySpend)
    .where(where)
    .orderBy(desc(dailySpend.date))
    .limit(limit ? parseInt(limit, 10) : 100);

  return c.json({ data: items });
});

// Get aggregated totals
usage.get("/summary", async (c) => {
  const db = getDb();
  const { startDate, endDate, apiKey } = c.req.query();

  const conditions: SQL[] = [];
  if (startDate) conditions.push(gte(dailySpend.date, startDate));
  if (endDate) conditions.push(lte(dailySpend.date, endDate));
  if (apiKey) conditions.push(eq(dailySpend.apiKey, apiKey));
  const where = conditions.length ? and(...conditions) : undefined;

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
  const { startDate, endDate } = c.req.query();

  const conditions: SQL[] = [];
  if (startDate) conditions.push(gte(dailySpend.date, startDate));
  if (endDate) conditions.push(lte(dailySpend.date, endDate));
  const where = conditions.length ? and(...conditions) : undefined;

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
  const { startDate, endDate } = c.req.query();

  const conditions: SQL[] = [];
  if (startDate) conditions.push(gte(dailySpend.date, startDate));
  if (endDate) conditions.push(lte(dailySpend.date, endDate));
  const where = conditions.length ? and(...conditions) : undefined;

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
  const { startDate, endDate } = c.req.query();

  const conditions: SQL[] = [];
  if (startDate) conditions.push(gte(dailySpend.date, startDate));
  if (endDate) conditions.push(lte(dailySpend.date, endDate));
  const where = conditions.length ? and(...conditions) : undefined;

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
