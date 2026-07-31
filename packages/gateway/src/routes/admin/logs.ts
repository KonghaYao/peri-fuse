/**
 * Admin API — Request logs and error logs queries.
 */
import { Hono } from "hono";
import { getDb } from "../../db.js";

const logs = new Hono();

// Query spend logs (request logs)
logs.get("/requests", async (c) => {
  const db = getDb();
  const { apiKey, model, provider, status, startDate, endDate, limit, offset, sessionId } = c.req.query();

  const where: any = {};
  if (apiKey) where.apiKey = apiKey;
  if (model) where.model = model;
  if (provider) where.provider = provider;
  if (status) where.status = status;
  if (sessionId) where.sessionId = sessionId;
  if (startDate || endDate) {
    where.startTime = {};
    if (startDate) where.startTime.gte = new Date(startDate);
    if (endDate) where.startTime.lte = new Date(endDate);
  }

  const [items, total] = await Promise.all([
    db.spendLog.findMany({
      where,
      orderBy: { startTime: "desc" },
      take: limit ? parseInt(limit, 10) : 50,
      skip: offset ? parseInt(offset, 10) : 0,
    }),
    db.spendLog.count({ where }),
  ]);

  return c.json({
    data: items.map((log) => ({
      ...log,
      metadata: JSON.parse(log.metadata),
      requestTags: JSON.parse(log.requestTags),
      messages: log.messages ? JSON.parse(log.messages) : null,
      response: log.response ? JSON.parse(log.response) : null,
    })),
    total,
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  });
});

// Get single spend log
logs.get("/requests/:id", async (c) => {
  const db = getDb();
  const log = await db.spendLog.findUnique({ where: { id: c.req.param("id") } });

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

  const where: any = {};
  if (modelGroup) where.modelGroup = modelGroup;
  if (exceptionType) where.exceptionType = exceptionType;
  if (startDate || endDate) {
    where.startTime = {};
    if (startDate) where.startTime.gte = new Date(startDate);
    if (endDate) where.startTime.lte = new Date(endDate);
  }

  const [items, total] = await Promise.all([
    db.errorLog.findMany({
      where,
      orderBy: { startTime: "desc" },
      take: limit ? parseInt(limit, 10) : 50,
      skip: offset ? parseInt(offset, 10) : 0,
    }),
    db.errorLog.count({ where }),
  ]);

  return c.json({
    data: items.map((log) => ({
      ...log,
      requestKwargs: JSON.parse(log.requestKwargs),
    })),
    total,
  });
});

export default logs;
