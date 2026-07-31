/**
 * Admin API — Usage statistics queries.
 */
import { Hono } from "hono";
import { getDb } from "../../db.js";

const usage = new Hono();

// Get daily spend summary with optional filters
usage.get("/daily", async (c) => {
  const db = getDb();
  const { startDate, endDate, apiKey, model, provider, limit } = c.req.query();

  const where: any = {};
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = startDate;
    if (endDate) where.date.lte = endDate;
  }
  if (apiKey) where.apiKey = apiKey;
  if (model) where.model = model;
  if (provider) where.provider = provider;

  const items = await db.dailySpend.findMany({
    where,
    orderBy: { date: "desc" },
    take: limit ? parseInt(limit, 10) : 100,
  });

  return c.json({ data: items });
});

// Get aggregated totals
usage.get("/summary", async (c) => {
  const db = getDb();
  const { startDate, endDate, apiKey } = c.req.query();

  const where: any = {};
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = startDate;
    if (endDate) where.date.lte = endDate;
  }
  if (apiKey) where.apiKey = apiKey;

  const result = await db.dailySpend.aggregate({
    where,
    _sum: {
      spend: true,
      promptTokens: true,
      completionTokens: true,
      apiRequests: true,
      successfulRequests: true,
      failedRequests: true,
    },
  });

  return c.json({
    totalSpend: result._sum.spend ?? 0,
    totalPromptTokens: result._sum.promptTokens ?? 0,
    totalCompletionTokens: result._sum.completionTokens ?? 0,
    totalRequests: result._sum.apiRequests ?? 0,
    successfulRequests: result._sum.successfulRequests ?? 0,
    failedRequests: result._sum.failedRequests ?? 0,
  });
});

// Get per-model breakdown
usage.get("/by-model", async (c) => {
  const db = getDb();
  const { startDate, endDate } = c.req.query();

  const where: any = {};
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = startDate;
    if (endDate) where.date.lte = endDate;
  }

  const results = await db.dailySpend.groupBy({
    by: ["model", "modelGroup"],
    where,
    _sum: { spend: true, promptTokens: true, completionTokens: true, apiRequests: true },
    _count: true,
  });

  return c.json({
    data: results.map((r) => ({
      model: r.model,
      modelGroup: r.modelGroup,
      totalSpend: r._sum.spend ?? 0,
      totalPromptTokens: r._sum.promptTokens ?? 0,
      totalCompletionTokens: r._sum.completionTokens ?? 0,
      totalRequests: r._sum.apiRequests ?? 0,
    })),
  });
});

// Get per-provider breakdown
usage.get("/by-provider", async (c) => {
  const db = getDb();
  const { startDate, endDate } = c.req.query();

  const where: any = {};
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = startDate;
    if (endDate) where.date.lte = endDate;
  }

  const results = await db.dailySpend.groupBy({
    by: ["provider"],
    where,
    _sum: { spend: true, promptTokens: true, completionTokens: true, apiRequests: true },
  });

  return c.json({
    data: results.map((r) => ({
      provider: r.provider,
      totalSpend: r._sum.spend ?? 0,
      totalPromptTokens: r._sum.promptTokens ?? 0,
      totalCompletionTokens: r._sum.completionTokens ?? 0,
      totalRequests: r._sum.apiRequests ?? 0,
    })),
  });
});

// Get per-key breakdown
usage.get("/by-key", async (c) => {
  const db = getDb();
  const { startDate, endDate } = c.req.query();

  const where: any = {};
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = startDate;
    if (endDate) where.date.lte = endDate;
  }

  const results = await db.dailySpend.groupBy({
    by: ["apiKey"],
    where,
    _sum: { spend: true, apiRequests: true },
  });

  return c.json({
    data: results.map((r) => ({
      apiKey: r.apiKey,
      totalSpend: r._sum.spend ?? 0,
      totalRequests: r._sum.apiRequests ?? 0,
    })),
  });
});

export default usage;
