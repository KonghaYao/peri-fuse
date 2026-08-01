/**
 * Admin API — Provider CRUD (project-scoped).
 */
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { GatewayEnv } from "../../app.js";
import { getDb } from "../../db.js";
import { auditLog, modelDeployment, provider } from "../../db/schema.js";
import { generateId } from "../../utils/id.js";
import { encrypt } from "../../utils/crypto.js";

const providers = new Hono<GatewayEnv>();

// List all providers for the current project
providers.get("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const items = await db.query.provider.findMany({
    where: eq(provider.projectId, projectId),
    orderBy: [desc(provider.createdAt)],
    with: {
      deployments: { where: eq(modelDeployment.isEnabled, true) },
    },
  });

  // Strip encrypted keys from response
  const safe = items.map((p) => ({
    ...p,
    apiKeyEncrypted: p.apiKeyEncrypted ? "***encrypted***" : null,
    deploymentCount: p.deployments.length,
    deployments: undefined,
  }));

  return c.json({ data: safe });
});

// Get single provider
providers.get("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const found = await db.query.provider.findFirst({
    where: and(eq(provider.id, c.req.param("id")), eq(provider.projectId, projectId)),
    with: { deployments: true },
  });

  if (!found) {
    return c.json({ error: { message: "Provider not found" } }, 404);
  }

  return c.json({
    ...found,
    apiKeyEncrypted: found.apiKeyEncrypted ? "***encrypted***" : null,
  });
});

// Create provider
providers.post("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const body = await c.req.json();

  const data: any = {
    id: generateId(),
    projectId,
    name: body.name,
    type: body.type,
    baseUrl: body.baseUrl,
    isEnabled: body.isEnabled ?? true,
    budgetLimit: body.budgetLimit ?? null,
    budgetPeriod: body.budgetPeriod ?? null,
    credentialId: body.credentialId ?? null,
  };

  if (body.apiKey) {
    data.apiKeyEncrypted = encrypt(body.apiKey);
  }

  // Calculate initial budgetResetAt
  if (data.budgetPeriod) {
    data.budgetResetAt = computeNextReset(data.budgetPeriod);
  }

  const [created] = await db.insert(provider).values(data).returning();

  // Audit log
  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "create",
    tableName: "Provider",
    objectId: created.id,
    afterValue: JSON.stringify({ ...created, apiKeyEncrypted: "***" }),
    changedBy: "admin",
  });

  return c.json(created, 201);
});

// Update provider
providers.put("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.query.provider.findFirst({
    where: and(eq(provider.id, id), eq(provider.projectId, projectId)),
  });
  if (!existing) {
    return c.json({ error: { message: "Provider not found" } }, 404);
  }

  const data: any = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.type !== undefined) data.type = body.type;
  if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl;
  if (body.isEnabled !== undefined) data.isEnabled = body.isEnabled;
  if (body.budgetLimit !== undefined) data.budgetLimit = body.budgetLimit;
  if (body.budgetPeriod !== undefined) {
    data.budgetPeriod = body.budgetPeriod;
    data.budgetResetAt = body.budgetPeriod ? computeNextReset(body.budgetPeriod) : null;
  }
  if (body.credentialId !== undefined) data.credentialId = body.credentialId;
  if (body.apiKey) {
    data.apiKeyEncrypted = encrypt(body.apiKey);
  }
  if (body.status !== undefined) data.status = body.status;

  const [updated] = await db.update(provider).set(data).where(eq(provider.id, id)).returning();

  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "update",
    tableName: "Provider",
    objectId: id,
    beforeValue: JSON.stringify({ ...existing, apiKeyEncrypted: "***" }),
    afterValue: JSON.stringify({ ...updated, apiKeyEncrypted: "***" }),
    changedBy: "admin",
  });

  return c.json(updated);
});

// Delete provider
providers.delete("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const id = c.req.param("id");

  const existing = await db.query.provider.findFirst({
    where: and(eq(provider.id, id), eq(provider.projectId, projectId)),
  });
  if (!existing) {
    return c.json({ error: { message: "Provider not found" } }, 404);
  }

  // Delete associated deployments first
  await db.delete(modelDeployment).where(eq(modelDeployment.providerId, id));
  await db.delete(provider).where(eq(provider.id, id));

  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "delete",
    tableName: "Provider",
    objectId: id,
    beforeValue: JSON.stringify({ ...existing, apiKeyEncrypted: "***" }),
    changedBy: "admin",
  });

  return c.json({ success: true });
});

function computeNextReset(period: string): string {
  const match = period.match(/^(\d+)([dhm])$/);
  if (!match) return new Date(Date.now() + 86400000).toISOString();
  const value = parseInt(match[1], 10);
  const unit = match[2];
  let ms = 0;
  switch (unit) {
    case "d": ms = value * 86400000; break;
    case "h": ms = value * 3600000; break;
    case "m": ms = value * 60000; break;
  }
  return new Date(Date.now() + ms).toISOString();
}

export default providers;
