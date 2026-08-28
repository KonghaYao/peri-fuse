/**
 * Admin API — Provider CRUD (project-scoped).
 */
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { GatewayEnv } from "../../app.js";
import { auditLog, credential, modelDeployment, provider } from "../../db/schema.js";
import { getDb } from "../../db.js";
import { nextBudgetResetAt } from "../../spend/budget-period.js";
import { encrypt } from "../../utils/crypto.js";
import { generateId } from "../../utils/id.js";

const providers = new Hono<GatewayEnv>();

function serializeProvider<T extends { apiKeyEncrypted: string | null }>(
  item: T,
): Omit<T, "apiKeyEncrypted"> & { apiKeyEncrypted: string | null } {
  return {
    ...item,
    apiKeyEncrypted: item.apiKeyEncrypted ? "***encrypted***" : null,
  };
}

// List all providers for the current project
providers.get("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const items = await db.query.provider.findMany({
    where: eq(provider.projectId, projectId),
    orderBy: [desc(provider.createdAt)],
    with: {
      deployments: {
        where: and(eq(modelDeployment.projectId, projectId), eq(modelDeployment.isEnabled, true)),
      },
    },
  });

  // Strip encrypted keys from response
  const safe = items.map((p) => ({
    ...serializeProvider(p),
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
    with: { deployments: { where: eq(modelDeployment.projectId, projectId) } },
  });

  if (!found) {
    return c.json({ error: { message: "Provider not found" } }, 404);
  }

  return c.json(serializeProvider(found));
});

// Create provider
providers.post("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const body = await c.req.json();

  if (body.credentialId != null) {
    const targetCredential = await db.query.credential.findFirst({
      where: and(eq(credential.id, body.credentialId), eq(credential.projectId, projectId)),
    });
    if (!targetCredential) {
      return c.json({ error: { message: "Credential not found" } }, 404);
    }
  }

  const budgetResetAt =
    body.budgetPeriod == null ? null : nextBudgetResetAt(body.budgetPeriod, new Date());
  if (body.budgetPeriod != null && budgetResetAt === null) {
    return c.json(
      {
        error: {
          message: "Provider budget period must be a positive integer followed by m, h, or d",
        },
      },
      400,
    );
  }

  const data: any = {
    id: generateId(),
    projectId,
    name: body.name,
    type: body.type,
    baseUrl: body.baseUrl,
    isEnabled: body.isEnabled ?? true,
    budgetLimit: body.budgetLimit ?? null,
    budgetPeriod: body.budgetPeriod ?? null,
    budgetResetAt,
    credentialId: body.credentialId ?? null,
  };

  if (body.apiKey) {
    data.apiKeyEncrypted = encrypt(body.apiKey);
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

  return c.json(serializeProvider(created), 201);
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

  if (body.credentialId !== undefined && body.credentialId !== null) {
    const targetCredential = await db.query.credential.findFirst({
      where: and(eq(credential.id, body.credentialId), eq(credential.projectId, projectId)),
    });
    if (!targetCredential) {
      return c.json({ error: { message: "Credential not found" } }, 404);
    }
  }

  const data: any = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.type !== undefined) data.type = body.type;
  if (body.baseUrl !== undefined) data.baseUrl = body.baseUrl;
  if (body.isEnabled !== undefined) data.isEnabled = body.isEnabled;
  if (body.budgetLimit !== undefined) data.budgetLimit = body.budgetLimit;
  if (body.budgetPeriod !== undefined) {
    const budgetResetAt =
      body.budgetPeriod === null ? null : nextBudgetResetAt(body.budgetPeriod, new Date());
    if (body.budgetPeriod !== null && budgetResetAt === null) {
      return c.json(
        {
          error: {
            message: "Provider budget period must be a positive integer followed by m, h, or d",
          },
        },
        400,
      );
    }
    data.budgetPeriod = body.budgetPeriod;
    data.budgetResetAt = budgetResetAt;
  }
  if (body.credentialId !== undefined) data.credentialId = body.credentialId;
  if (body.apiKey) {
    data.apiKeyEncrypted = encrypt(body.apiKey);
  }
  if (body.status !== undefined) data.status = body.status;

  const [updated] = await db
    .update(provider)
    .set(data)
    .where(and(eq(provider.id, id), eq(provider.projectId, projectId)))
    .returning();

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

  return c.json(serializeProvider(updated));
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

  try {
    db.transaction((tx) => {
      tx.delete(modelDeployment)
        .where(and(eq(modelDeployment.providerId, id), eq(modelDeployment.projectId, projectId)))
        .run();
      tx.delete(provider)
        .where(and(eq(provider.id, id), eq(provider.projectId, projectId)))
        .run();
      tx.insert(auditLog)
        .values({
          id: generateId(),
          projectId,
          action: "delete",
          tableName: "Provider",
          objectId: id,
          beforeValue: JSON.stringify({ ...existing, apiKeyEncrypted: "***" }),
          changedBy: "admin",
        })
        .run();
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "SQLITE_CONSTRAINT_FOREIGNKEY"
    ) {
      console.error(
        `[peri-gateway] Refused provider deletion for project ${projectId}, provider ${id}:`,
        error,
      );
      return c.json(
        { error: { message: "Provider cannot be deleted while deployments reference it" } },
        409,
      );
    }
    throw error;
  }

  return c.json({ success: true });
});

export default providers;
