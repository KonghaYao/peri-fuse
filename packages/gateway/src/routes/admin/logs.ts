/**
 * Admin API — Request logs and error logs queries.
 */
import { Hono } from "hono";
import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { getDb } from "../../db.js";
import { errorLog, spendLog } from "../../db/schema.js";

const logs = new Hono();

// Query spend logs (request logs)
logs.get("/requests", async (c) => {
  const db = getDb();
  const { apiKey, model, provider, status, startDate, endDate, limit, offset, sessionId } = c.req.query();

  const conditions: SQL[] = [];
  if (apiKey) conditions.push(eq(spendLog.apiKey, apiKey));
  if (model) conditions.push(eq(spendLog.model, model));
  if (provider) conditions.push(eq(spendLog.provider, provider));
  if (status) conditions.push(eq(spendLog.status, status));
  if (sessionId) conditions.push(eq(spendLog.sessionId, sessionId));
  if (startDate) conditions.push(gte(spendLog.startTime, new Date(startDate).toISOString()));
  if (endDate) conditions.push(lte(spendLog.startTime, new Date(endDate).toISOString()));
  const where = conditions.length ? and(...conditions) : undefined;

  const limitNum = limit ? parseInt(limit, 10) : 50;
  const offsetNum = offset ? parseInt(offset, 10) : 0;

  const [items, totalRow] = await Promise.all([
    db
      .select()
      .from(spendLog)
      .where(where)
      .orderBy(desc(spendLog.startTime))
      .limit(limitNum)
      .offset(offsetNum),
    db.select({ value: count() }).from(spendLog).where(where),
  ]);

  return c.json({
    data: items.map((log) => ({
      ...log,
      metadata: JSON.parse(log.metadata),
      requestTags: JSON.parse(log.requestTags),
      messages: log.messages ? JSON.parse(log.messages) : null,
      response: log.response ? JSON.parse(log.response) : null,
    })),
    total: totalRow[0]?.value ?? 0,
    limit: limitNum,
    offset: offsetNum,
  });
});

// Get single spend log
logs.get("/requests/:id", async (c) => {
  const db = getDb();
  const log = await db.query.spendLog.findFirst({ where: eq(spendLog.id, c.req.param("id")) });

  if (!log) {
    return c.json({ error: { message: "Log not found" } }, 404);
  }

  return c.json({
    ...log,
    metadata: JSON.parse(log.metadata),
    requestTags: JSON.parse(log.requestTags),
    messages: log.messages ? JSON.parse(log.messages) : null,
    response: log.response ? JSON.parse(log.response) : null,
  });
});

// Query error logs
logs.get("/errors", async (c) => {
  const db = getDb();
  const { modelGroup, exceptionType, startDate, endDate, limit, offset } = c.req.query();

  const conditions: SQL[] = [];
  if (modelGroup) conditions.push(eq(errorLog.modelGroup, modelGroup));
  if (exceptionType) conditions.push(eq(errorLog.exceptionType, exceptionType));
  if (startDate) conditions.push(gte(errorLog.startTime, new Date(startDate).toISOString()));
  if (endDate) conditions.push(lte(errorLog.startTime, new Date(endDate).toISOString()));
  const where = conditions.length ? and(...conditions) : undefined;

  const limitNum = limit ? parseInt(limit, 10) : 50;
  const offsetNum = offset ? parseInt(offset, 10) : 0;

  const [items, totalRow] = await Promise.all([
    db
      .select()
      .from(errorLog)
      .where(where)
      .orderBy(desc(errorLog.startTime))
      .limit(limitNum)
      .offset(offsetNum),
    db.select({ value: count() }).from(errorLog).where(where),
  ]);

  return c.json({
    data: items.map((log) => ({
      ...log,
      requestKwargs: JSON.parse(log.requestKwargs),
    })),
    total: totalRow[0]?.value ?? 0,
  });
});

export default logs;
