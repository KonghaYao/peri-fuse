/**
 * Admin API — Request logs and error logs queries (project-scoped).
 */

import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { GatewayEnv } from "../../app.js";
import { errorLog, spendLog } from "../../db/schema.js";
import { getDb } from "../../db.js";
import { parseAdminListQuery } from "./list-query.js";

const logs = new Hono<GatewayEnv>();

// Query spend logs (request logs)
logs.get("/requests", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const rawQuery = c.req.query();
  const parsedQuery = parseAdminListQuery(rawQuery);
  if (!parsedQuery.ok) {
    return c.json({ error: { message: parsedQuery.message } }, 400);
  }
  const { limit, offset, startDate, endDate } = parsedQuery.value;
  const { apiKey, model, provider, status, sessionId } = rawQuery;

  const conditions: SQL[] = [eq(spendLog.projectId, projectId)];
  if (apiKey) conditions.push(eq(spendLog.apiKey, apiKey));
  if (model) conditions.push(eq(spendLog.model, model));
  if (provider) conditions.push(eq(spendLog.provider, provider));
  if (status) conditions.push(eq(spendLog.status, status));
  if (sessionId) conditions.push(eq(spendLog.sessionId, sessionId));
  if (startDate) conditions.push(gte(spendLog.startTime, new Date(startDate).toISOString()));
  if (endDate) conditions.push(lte(spendLog.startTime, new Date(endDate).toISOString()));
  const where = and(...conditions);

  const [items, totalRow] = await Promise.all([
    db
      .select()
      .from(spendLog)
      .where(where)
      .orderBy(desc(spendLog.startTime))
      .limit(limit)
      .offset(offset),
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
    limit,
    offset,
  });
});

// Get single spend log
logs.get("/requests/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const log = await db.query.spendLog.findFirst({
    where: and(eq(spendLog.id, c.req.param("id")), eq(spendLog.projectId, projectId)),
  });

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
  const projectId = c.get("projectId");
  const rawQuery = c.req.query();
  const parsedQuery = parseAdminListQuery(rawQuery);
  if (!parsedQuery.ok) {
    return c.json({ error: { message: parsedQuery.message } }, 400);
  }
  const { limit, offset, startDate, endDate } = parsedQuery.value;
  const { modelGroup, exceptionType } = rawQuery;

  const conditions: SQL[] = [eq(errorLog.projectId, projectId)];
  if (modelGroup) conditions.push(eq(errorLog.modelGroup, modelGroup));
  if (exceptionType) conditions.push(eq(errorLog.exceptionType, exceptionType));
  if (startDate) conditions.push(gte(errorLog.startTime, new Date(startDate).toISOString()));
  if (endDate) conditions.push(lte(errorLog.startTime, new Date(endDate).toISOString()));
  const where = and(...conditions);

  const [items, totalRow] = await Promise.all([
    db
      .select()
      .from(errorLog)
      .where(where)
      .orderBy(desc(errorLog.startTime))
      .limit(limit)
      .offset(offset),
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
