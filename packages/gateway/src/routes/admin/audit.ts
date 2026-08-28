/**
 * Admin API — Audit log queries (project-scoped).
 */

import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { GatewayEnv } from "../../app.js";
import { auditLog } from "../../db/schema.js";
import { getDb } from "../../db.js";
import { parseAdminListQuery } from "./list-query.js";
import { parseStoredJson } from "./safe-json.js";

const audit = new Hono<GatewayEnv>();

type AuditLogRow = typeof auditLog.$inferSelect;

function serializeAuditLog(log: AuditLogRow) {
  const meta = { projectId: log.projectId, entity: "AuditLog", id: log.id };
  return {
    ...log,
    beforeValue: parseStoredJson(log.beforeValue, null, { ...meta, field: "beforeValue" }),
    afterValue: parseStoredJson(log.afterValue, null, { ...meta, field: "afterValue" }),
  };
}

// Query audit logs
audit.get("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const rawQuery = c.req.query();
  const parsedQuery = parseAdminListQuery(rawQuery);
  if (!parsedQuery.ok) {
    return c.json({ error: { message: parsedQuery.message } }, 400);
  }
  const { limit, offset, startDate, endDate } = parsedQuery.value;
  const { tableName, objectId, action } = rawQuery;

  const conditions: SQL[] = [eq(auditLog.projectId, projectId)];
  if (tableName) conditions.push(eq(auditLog.tableName, tableName));
  if (objectId) conditions.push(eq(auditLog.objectId, objectId));
  if (action) conditions.push(eq(auditLog.action, action));
  if (startDate) conditions.push(gte(auditLog.createdAt, new Date(startDate).toISOString()));
  if (endDate) conditions.push(lte(auditLog.createdAt, new Date(endDate).toISOString()));
  const where = and(...conditions);

  const [items, totalRow] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(auditLog).where(where),
  ]);

  return c.json({
    data: items.map(serializeAuditLog),
    total: totalRow[0]?.value ?? 0,
  });
});

export default audit;
