/**
 * Admin API — API Key config CRUD (project-scoped).
 * Keys are created in the shared DB (server); here we manage gateway-side
 * config (rate limits, budget) keyed by publicKey within a project.
 */
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { GatewayEnv } from "../../app.js";
import { projectApiKeyExists } from "../../auth/shared-api-key-store.js";
import { apiKey, auditLog, budget } from "../../db/schema.js";
import { getDb } from "../../db.js";
import { generateId } from "../../utils/id.js";

const keys = new Hono<GatewayEnv>();

// List all key configs for the current project
keys.get("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const items = await db
    .select({ key: apiKey, budget })
    .from(apiKey)
    .leftJoin(budget, and(eq(apiKey.budgetId, budget.id), eq(budget.projectId, projectId)))
    .where(eq(apiKey.projectId, projectId))
    .orderBy(desc(apiKey.createdAt));

  const safe = items.map(({ key, budget: relatedBudget }) => ({
    ...key,
    budget: relatedBudget,
    models: JSON.parse(key.models),
    metadata: JSON.parse(key.metadata),
  }));

  return c.json({ data: safe });
});

// Get single key config
keys.get("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const [result] = await db
    .select({ key: apiKey, budget })
    .from(apiKey)
    .leftJoin(budget, and(eq(apiKey.budgetId, budget.id), eq(budget.projectId, projectId)))
    .where(and(eq(apiKey.id, c.req.param("id")), eq(apiKey.projectId, projectId)))
    .limit(1);

  if (!result) {
    return c.json({ error: { message: "API key config not found" } }, 404);
  }

  return c.json({
    ...result.key,
    budget: result.budget,
    models: JSON.parse(result.key.models),
    metadata: JSON.parse(result.key.metadata),
  });
});

// Create key config — attach gateway limits to an existing publicKey
keys.post("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const body = await c.req.json();

  if (!body.publicKey || typeof body.publicKey !== "string") {
    return c.json({ error: { message: "publicKey is required" } }, 400);
  }

  if (!projectApiKeyExists(body.publicKey, projectId)) {
    return c.json({ error: { message: "Project API key not found" } }, 404);
  }

  if (body.budgetId != null) {
    const targetBudget = await db.query.budget.findFirst({
      where: and(eq(budget.id, body.budgetId), eq(budget.projectId, projectId)),
    });
    if (!targetBudget) {
      return c.json({ error: { message: "Budget not found" } }, 404);
    }
  }

  // Check if config already exists for this publicKey
  const existing = await db.query.apiKey.findFirst({ where: eq(apiKey.publicKey, body.publicKey) });
  if (existing) {
    return c.json({ error: { message: "Config already exists for this publicKey" } }, 409);
  }

  const [key] = await db
    .insert(apiKey)
    .values({
      id: generateId(),
      projectId,
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
    })
    .returning();

  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "create",
    tableName: "ApiKey",
    objectId: key.id,
    afterValue: JSON.stringify({ keyName: key.keyName, publicKey: key.publicKey }),
    changedBy: "admin",
  });

  return c.json(
    {
      ...key,
      models: JSON.parse(key.models),
      metadata: JSON.parse(key.metadata),
    },
    201,
  );
});

// Update key config
keys.put("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.query.apiKey.findFirst({
    where: and(eq(apiKey.id, id), eq(apiKey.projectId, projectId)),
  });
  if (!existing) {
    return c.json({ error: { message: "API key config not found" } }, 404);
  }

  if (!projectApiKeyExists(existing.publicKey, projectId)) {
    return c.json({ error: { message: "Project API key not found" } }, 404);
  }

  if (body.budgetId !== undefined && body.budgetId !== null) {
    const targetBudget = await db.query.budget.findFirst({
      where: and(eq(budget.id, body.budgetId), eq(budget.projectId, projectId)),
    });
    if (!targetBudget) {
      return c.json({ error: { message: "Budget not found" } }, 404);
    }
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

  const [key] = await db
    .update(apiKey)
    .set(data)
    .where(and(eq(apiKey.id, id), eq(apiKey.projectId, projectId)))
    .returning();

  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "update",
    tableName: "ApiKey",
    objectId: id,
    beforeValue: JSON.stringify({ keyName: existing.keyName, isEnabled: existing.isEnabled }),
    afterValue: JSON.stringify({ keyName: key.keyName, isEnabled: key.isEnabled }),
    changedBy: "admin",
  });

  return c.json({ ...key, models: JSON.parse(key.models), metadata: JSON.parse(key.metadata) });
});

// Delete key config
keys.delete("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const id = c.req.param("id");

  const existing = await db.query.apiKey.findFirst({
    where: and(eq(apiKey.id, id), eq(apiKey.projectId, projectId)),
  });
  if (!existing) {
    return c.json({ error: { message: "API key config not found" } }, 404);
  }

  if (!projectApiKeyExists(existing.publicKey, projectId)) {
    return c.json({ error: { message: "Project API key not found" } }, 404);
  }

  await db.delete(apiKey).where(and(eq(apiKey.id, id), eq(apiKey.projectId, projectId)));

  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "delete",
    tableName: "ApiKey",
    objectId: id,
    beforeValue: JSON.stringify({ keyName: existing.keyName, publicKey: existing.publicKey }),
    changedBy: "admin",
  });

  return c.json({ success: true });
});

export default keys;
