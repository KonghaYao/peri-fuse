/**
 * Admin API — Provider CRUD.
 */
import { Hono } from "hono";
import { getDb } from "../../db.js";
import { encrypt, decrypt } from "../../utils/crypto.js";

const providers = new Hono();

// List all providers
providers.get("/", async (c) => {
  const db = getDb();
  const items = await db.provider.findMany({
    orderBy: { createdAt: "desc" },
    include: { deployments: { where: { isEnabled: true } } },
  });

  // Strip encrypted keys from response
  const safe = items.map((p) => ({
    ...p,
    apiKeyEncrypted: p.apiKeyEncrypted ? "***encrypted***" : null,
    _deployments: undefined,
    deploymentCount: p.deployments.length,
  }));

  return c.json({ data: safe });
});

// Get single provider
providers.get("/:id", async (c) => {
  const db = getDb();
  const provider = await db.provider.findUnique({
    where: { id: c.req.param("id") },
    include: { deployments: true },
  });

  if (!provider) {
    return c.json({ error: { message: "Provider not found" } }, 404);
  }

  return c.json({
    ...provider,
    apiKeyEncrypted: provider.apiKeyEncrypted ? "***encrypted***" : null,
  });
});

// Create provider
providers.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.json();

  const data: any = {
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

  const provider = await db.provider.create({ data });

  // Audit log
  await db.auditLog.create({
    data: {
      action: "create",
      tableName: "Provider",
      objectId: provider.id,
      afterValue: JSON.stringify({ ...provider, apiKeyEncrypted: "***" }),
      changedBy: "admin",
    },
  });

  return c.json(provider, 201);
});

// Update provider
providers.put("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.provider.findUnique({ where: { id } });
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

  const provider = await db.provider.update({ where: { id }, data });

  await db.auditLog.create({
    data: {
      action: "update",
      tableName: "Provider",
      objectId: id,
      beforeValue: JSON.stringify({ ...existing, apiKeyEncrypted: "***" }),
      afterValue: JSON.stringify({ ...provider, apiKeyEncrypted: "***" }),
      changedBy: "admin",
    },
  });

  return c.json(provider);
});

// Delete provider
providers.delete("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");

  const existing = await db.provider.findUnique({ where: { id } });
  if (!existing) {
    return c.json({ error: { message: "Provider not found" } }, 404);
  }

  // Delete associated deployments first
  await db.modelDeployment.deleteMany({ where: { providerId: id } });
  await db.provider.delete({ where: { id } });

  await db.auditLog.create({
    data: {
      action: "delete",
      tableName: "Provider",
      objectId: id,
      beforeValue: JSON.stringify({ ...existing, apiKeyEncrypted: "***" }),
      changedBy: "admin",
    },
  });

  return c.json({ success: true });
});

function computeNextReset(period: string): Date {
  const match = period.match(/^(\d+)([dhm])$/);
  if (!match) return new Date(Date.now() + 86400000);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  let ms = 0;
  switch (unit) {
    case "d": ms = value * 86400000; break;
    case "h": ms = value * 3600000; break;
    case "m": ms = value * 60000; break;
  }
  return new Date(Date.now() + ms);
}

export default providers;
