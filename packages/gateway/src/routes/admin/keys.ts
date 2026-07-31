/**
 * Admin API — API Key config CRUD.
 * Keys are created in the shared DB (server); here we manage gateway-side
 * config (rate limits, budget) keyed by publicKey.
 */
import { Hono } from "hono";
import { getDb } from "../../db.js";

const keys = new Hono();

// List all key configs
keys.get("/", async (c) => {
  const db = getDb();
  const items = await db.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    include: { budget: true },
  });

  const safe = items.map((k) => ({
    ...k,
    models: JSON.parse(k.models),
    metadata: JSON.parse(k.metadata),
  }));

  return c.json({ data: safe });
});

// Get single key config
keys.get("/:id", async (c) => {
  const db = getDb();
  const key = await db.apiKey.findUnique({
    where: { id: c.req.param("id") },
    include: { budget: true },
  });

  if (!key) {
    return c.json({ error: { message: "API key config not found" } }, 404);
  }

  return c.json({ ...key, models: JSON.parse(key.models), metadata: JSON.parse(key.metadata) });
});

// Create key config — attach gateway limits to an existing publicKey
keys.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.json();

  if (!body.publicKey || typeof body.publicKey !== "string") {
    return c.json({ error: { message: "publicKey is required" } }, 400);
  }

  // Check if config already exists for this publicKey
  const existing = await db.apiKey.findUnique({ where: { publicKey: body.publicKey } });
  if (existing) {
    return c.json({ error: { message: "Config already exists for this publicKey" } }, 409);
  }

  const key = await db.apiKey.create({
    data: {
      publicKey: body.publicKey,
      keyName: body.keyName ?? null,
      models: JSON.stringify(body.models ?? []),
      metadata: JSON.stringify(body.metadata ?? {}),
      maxParallel: body.maxParallel ?? null,
      tpmLimit: body.tpmLimit ?? null,
      rpmLimit: body.rpmLimit ?? null,
      maxBudget: body.maxBudget ?? null,
      budgetId: body.budgetId ?? null,
      isEnabled: body.isEnabled ?? true,
    },
  });

  await db.auditLog.create({
    data: {
      action: "create",
      tableName: "ApiKey",
      objectId: key.id,
      afterValue: JSON.stringify({ keyName: key.keyName, publicKey: key.publicKey }),
      changedBy: "admin",
    },
  });

  return c.json({
    ...key,
    models: JSON.parse(key.models),
    metadata: JSON.parse(key.metadata),
  }, 201);
});

// Update key config
keys.put("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.apiKey.findUnique({ where: { id } });
  if (!existing) {
    return c.json({ error: { message: "API key config not found" } }, 404);
  }

  const data: any = {};
  if (body.keyName !== undefined) data.keyName = body.keyName;
  if (body.models !== undefined) data.models = JSON.stringify(body.models);
  if (body.metadata !== undefined) data.metadata = JSON.stringify(body.metadata);
  if (body.maxParallel !== undefined) data.maxParallel = body.maxParallel;
  if (body.tpmLimit !== undefined) data.tpmLimit = body.tpmLimit;
  if (body.rpmLimit !== undefined) data.rpmLimit = body.rpmLimit;
  if (body.maxBudget !== undefined) data.maxBudget = body.maxBudget;
  if (body.budgetId !== undefined) data.budgetId = body.budgetId;
  if (body.isEnabled !== undefined) data.isEnabled = body.isEnabled;

  const key = await db.apiKey.update({ where: { id }, data });

  await db.auditLog.create({
    data: {
      action: "update",
      tableName: "ApiKey",
      objectId: id,
      beforeValue: JSON.stringify({ keyName: existing.keyName, isEnabled: existing.isEnabled }),
      afterValue: JSON.stringify({ keyName: key.keyName, isEnabled: key.isEnabled }),
      changedBy: "admin",
    },
  });

  return c.json({ ...key, models: JSON.parse(key.models), metadata: JSON.parse(key.metadata) });
});

// Delete key config
keys.delete("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");

  const existing = await db.apiKey.findUnique({ where: { id } });
  if (!existing) {
    return c.json({ error: { message: "API key config not found" } }, 404);
  }

  await db.apiKey.delete({ where: { id } });

  await db.auditLog.create({
    data: {
      action: "delete",
      tableName: "ApiKey",
      objectId: id,
      beforeValue: JSON.stringify({ keyName: existing.keyName, publicKey: existing.publicKey }),
      changedBy: "admin",
    },
  });

  return c.json({ success: true });
});

export default keys;
