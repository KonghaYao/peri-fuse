/**
 * Admin API — Audit log queries.
 */
import { Hono } from "hono";
import { getDb } from "../../db.js";

const audit = new Hono();

// Query audit logs
audit.get("/", async (c) => {
  const db = getDb();
  const { tableName, objectId, action, startDate, endDate, limit, offset } = c.req.query();

  const where: any = {};
  if (tableName) where.tableName = tableName;
  if (objectId) where.objectId = objectId;
  if (action) where.action = action;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [items, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit ? parseInt(limit, 10) : 50,
      skip: offset ? parseInt(offset, 10) : 0,
    }),
    db.auditLog.count({ where }),
  ]);

  return c.json({
    data: items.map((log) => ({
      ...log,
      beforeValue: log.beforeValue ? JSON.parse(log.beforeValue) : null,
      afterValue: log.afterValue ? JSON.parse(log.afterValue) : null,
    })),
    total,
  });
});

export default audit;
