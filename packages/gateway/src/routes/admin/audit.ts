/**
 * Admin API — Audit log queries.
 */
import { Hono } from "hono";
import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { getDb } from "../../db.js";
import { auditLog } from "../../db/schema.js";

const audit = new Hono();

// Query audit logs
audit.get("/", async (c) => {
  const db = getDb();
  const { tableName, objectId, action, startDate, endDate, limit, offset } = c.req.query();

  const conditions: SQL[] = [];
  if (tableName) conditions.push(eq(auditLog.tableName, tableName));
  if (objectId) conditions.push(eq(auditLog.objectId, objectId));
  if (action) conditions.push(eq(auditLog.action, action));
  if (startDate) conditions.push(gte(auditLog.createdAt, new Date(startDate).toISOString()));
  if (endDate) conditions.push(lte(auditLog.createdAt, new Date(endDate).toISOString()));
  const where = conditions.length ? and(...conditions) : undefined;

  const limitNum = limit ? parseInt(limit, 10) : 50;
  const offsetNum = offset ? parseInt(offset, 10) : 0;

  const [items, totalRow] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(limitNum)
      .offset(offsetNum),
    db.select({ value: count() }).from(auditLog).where(where),
  ]);

  return c.json({
    data: items.map((log) => ({
      ...log,
      beforeValue: log.beforeValue ? JSON.parse(log.beforeValue) : null,
      afterValue: log.afterValue ? JSON.parse(log.afterValue) : null,
    })),
    total: totalRow[0]?.value ?? 0,
  });
});

export default audit;
