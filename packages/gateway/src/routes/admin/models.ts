/**
 * Admin API — Model Deployment CRUD (project-scoped).
 */
import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { GatewayEnv } from "../../app.js";
import { getDb } from "../../db.js";
import { auditLog, modelDeployment, provider } from "../../db/schema.js";
import { generateId } from "../../utils/id.js";

const models = new Hono<GatewayEnv>();

// List all model deployments for the current project
models.get("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const items = await db.query.modelDeployment.findMany({
    where: eq(modelDeployment.projectId, projectId),
    orderBy: [desc(modelDeployment.createdAt)],
    with: {
      provider: {
        columns: { id: true, name: true, type: true, isEnabled: true, status: true },
      },
    },
  });

  const safe = items.map((d) => ({
    ...d,
    litellmParams: JSON.parse(d.litellmParams),
    modelInfo: d.modelInfo ? JSON.parse(d.modelInfo) : null,
  }));

  return c.json({ data: safe });
});

// List unique model names (aliases) for the current project
models.get("/aliases", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const results = await db
    .select({ modelName: modelDeployment.modelName, value: count() })
    .from(modelDeployment)
    .where(and(eq(modelDeployment.isEnabled, true), eq(modelDeployment.projectId, projectId)))
    .groupBy(modelDeployment.modelName);

  return c.json({
    data: results.map((r) => ({ modelName: r.modelName, deploymentCount: r.value })),
  });
});

// Get single deployment
models.get("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const deployment = await db.query.modelDeployment.findFirst({
    where: and(eq(modelDeployment.id, c.req.param("id")), eq(modelDeployment.projectId, projectId)),
    with: { provider: true },
  });

  if (!deployment) {
    return c.json({ error: { message: "Deployment not found" } }, 404);
  }

  return c.json({
    ...deployment,
    litellmParams: JSON.parse(deployment.litellmParams),
    modelInfo: deployment.modelInfo ? JSON.parse(deployment.modelInfo) : null,
  });
});

// Create deployment
models.post("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const body = await c.req.json();

  if (!body.modelName || !body.providerId || !body.providerModel) {
    return c.json({ error: { message: "modelName, providerId, and providerModel are required" } }, 400);
  }

  // Verify provider exists within the same project
  const prov = await db.query.provider.findFirst({
    where: and(eq(provider.id, body.providerId), eq(provider.projectId, projectId)),
  });
  if (!prov) {
    return c.json({ error: { message: "Provider not found" } }, 404);
  }

  const [deployment] = await db
    .insert(modelDeployment)
    .values({
      id: generateId(),
      projectId,
      modelName: body.modelName,
      providerId: body.providerId,
      providerModel: body.providerModel,
      litellmParams: JSON.stringify(body.litellmParams ?? {}),
      modelInfo: body.modelInfo ? JSON.stringify(body.modelInfo) : null,
      isEnabled: body.isEnabled ?? true,
    })
    .returning();

  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "create",
    tableName: "ModelDeployment",
    objectId: deployment.id,
    afterValue: JSON.stringify({ modelName: deployment.modelName, providerModel: deployment.providerModel }),
    changedBy: "admin",
  });

  return c.json(deployment, 201);
});

// Update deployment
models.put("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.query.modelDeployment.findFirst({
    where: and(eq(modelDeployment.id, id), eq(modelDeployment.projectId, projectId)),
  });
  if (!existing) {
    return c.json({ error: { message: "Deployment not found" } }, 404);
  }

  const data: any = {};
  if (body.modelName !== undefined) data.modelName = body.modelName;
  if (body.providerModel !== undefined) data.providerModel = body.providerModel;
  if (body.providerId !== undefined) data.providerId = body.providerId;
  if (body.litellmParams !== undefined) data.litellmParams = JSON.stringify(body.litellmParams);
  if (body.modelInfo !== undefined) data.modelInfo = body.modelInfo ? JSON.stringify(body.modelInfo) : null;
  if (body.isEnabled !== undefined) data.isEnabled = body.isEnabled;

  const [deployment] = await db
    .update(modelDeployment)
    .set(data)
    .where(eq(modelDeployment.id, id))
    .returning();

  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "update",
    tableName: "ModelDeployment",
    objectId: id,
    beforeValue: JSON.stringify({ modelName: existing.modelName, isEnabled: existing.isEnabled }),
    afterValue: JSON.stringify({ modelName: deployment.modelName, isEnabled: deployment.isEnabled }),
    changedBy: "admin",
  });

  return c.json(deployment);
});

// Delete deployment
models.delete("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const id = c.req.param("id");

  const existing = await db.query.modelDeployment.findFirst({
    where: and(eq(modelDeployment.id, id), eq(modelDeployment.projectId, projectId)),
  });
  if (!existing) {
    return c.json({ error: { message: "Deployment not found" } }, 404);
  }

  await db.delete(modelDeployment).where(eq(modelDeployment.id, id));

  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "delete",
    tableName: "ModelDeployment",
    objectId: id,
    beforeValue: JSON.stringify({ modelName: existing.modelName, providerModel: existing.providerModel }),
    changedBy: "admin",
  });

  return c.json({ success: true });
});

export default models;
