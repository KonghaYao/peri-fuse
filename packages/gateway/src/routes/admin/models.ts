/**
 * Admin API — Model Deployment CRUD.
 */
import { Hono } from "hono";
import { getDb } from "../../db.js";

const models = new Hono();

// List all model deployments
models.get("/", async (c) => {
  const db = getDb();
  const items = await db.modelDeployment.findMany({
    orderBy: { createdAt: "desc" },
    include: { provider: { select: { id: true, name: true, type: true, isEnabled: true, status: true } } },
  });

  const safe = items.map((d) => ({
    ...d,
    litellmParams: JSON.parse(d.litellmParams),
    modelInfo: d.modelInfo ? JSON.parse(d.modelInfo) : null,
  }));

  return c.json({ data: safe });
});

// List unique model names (aliases)
models.get("/aliases", async (c) => {
  const db = getDb();
  const results = await db.modelDeployment.groupBy({
    by: ["modelName"],
    where: { isEnabled: true },
    _count: true,
  });

  return c.json({
    data: results.map((r) => ({ modelName: r.modelName, deploymentCount: r._count })),
  });
});

// Get single deployment
models.get("/:id", async (c) => {
  const db = getDb();
  const deployment = await db.modelDeployment.findUnique({
    where: { id: c.req.param("id") },
    include: { provider: true },
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
  const body = await c.req.json();

  if (!body.modelName || !body.providerId || !body.providerModel) {
    return c.json({ error: { message: "modelName, providerId, and providerModel are required" } }, 400);
  }

  // Verify provider exists
  const provider = await db.provider.findUnique({ where: { id: body.providerId } });
  if (!provider) {
    return c.json({ error: { message: "Provider not found" } }, 404);
  }

  const deployment = await db.modelDeployment.create({
    data: {
      modelName: body.modelName,
      providerId: body.providerId,
      providerModel: body.providerModel,
      litellmParams: JSON.stringify(body.litellmParams ?? {}),
      modelInfo: body.modelInfo ? JSON.stringify(body.modelInfo) : null,
      isEnabled: body.isEnabled ?? true,
    },
  });

  await db.auditLog.create({
    data: {
      action: "create",
      tableName: "ModelDeployment",
      objectId: deployment.id,
      afterValue: JSON.stringify({ modelName: deployment.modelName, providerModel: deployment.providerModel }),
      changedBy: "admin",
    },
  });

  return c.json(deployment, 201);
});

// Update deployment
models.put("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.modelDeployment.findUnique({ where: { id } });
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

  const deployment = await db.modelDeployment.update({ where: { id }, data });

  await db.auditLog.create({
    data: {
      action: "update",
      tableName: "ModelDeployment",
      objectId: id,
      beforeValue: JSON.stringify({ modelName: existing.modelName, isEnabled: existing.isEnabled }),
      afterValue: JSON.stringify({ modelName: deployment.modelName, isEnabled: deployment.isEnabled }),
      changedBy: "admin",
    },
  });

  return c.json(deployment);
});

// Delete deployment
models.delete("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");

  const existing = await db.modelDeployment.findUnique({ where: { id } });
  if (!existing) {
    return c.json({ error: { message: "Deployment not found" } }, 404);
  }

  await db.modelDeployment.delete({ where: { id } });

  await db.auditLog.create({
    data: {
      action: "delete",
      tableName: "ModelDeployment",
      objectId: id,
      beforeValue: JSON.stringify({ modelName: existing.modelName, providerModel: existing.providerModel }),
      changedBy: "admin",
    },
  });

  return c.json({ success: true });
});

export default models;
