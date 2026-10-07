import { isDatabaseConstraint } from "@peri-fuse/shared/src/db/errors";
import { relationalFilter } from "@peri-fuse/shared/src/db/relational-filter";
/**
 * Admin API — Provider CRUD (project-scoped).
 */
import { and, desc, eq, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { GatewayEnv } from "../../app.js";
import { auditLog, credential, modelDeployment, provider } from "../../db/schema.js";
import { getDb } from "../../db.js";
import { clearProviderRoutingState } from "../../router/index.js";
import { nextBudgetResetAt } from "../../spend/budget-period.js";
import { encrypt } from "../../utils/crypto.js";
import { generateId } from "../../utils/id.js";
import { validateEnabled } from "./filter-query.js";

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
  const raw = c.req.query();
  const error = validateEnabled(raw);
  if (error) return c.json({ error: { message: error } }, 400);
  const conditions: SQL[] = [eq(provider.projectId, projectId)];
  if (raw.name) conditions.push(eq(provider.name, raw.name));
  if (raw.type) conditions.push(eq(provider.type, raw.type));
  if (raw.status) conditions.push(eq(provider.status, raw.status));
  if (raw.isEnabled !== undefined)
    conditions.push(eq(provider.isEnabled, raw.isEnabled === "true"));
  const items = await db.query.provider.findMany({
    where: relationalFilter(and(...conditions)),
    orderBy: (table) => [desc(table.createdAt)],
    with: {
      deployments: {
        where: relationalFilter(
          and(eq(modelDeployment.projectId, projectId), eq(modelDeployment.isEnabled, true)),
        ),
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
    where: relationalFilter(
      and(eq(provider.id, c.req.param("id")), eq(provider.projectId, projectId)),
    ),
    with: { deployments: { where: relationalFilter(eq(modelDeployment.projectId, projectId)) } },
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
      where: relationalFilter(
        and(eq(credential.id, body.credentialId), eq(credential.projectId, projectId)),
      ),
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
    where: relationalFilter(and(eq(provider.id, id), eq(provider.projectId, projectId))),
  });
  if (!existing) {
    return c.json({ error: { message: "Provider not found" } }, 404);
  }

  if (body.credentialId !== undefined && body.credentialId !== null) {
    const targetCredential = await db.query.credential.findFirst({
      where: relationalFilter(
        and(eq(credential.id, body.credentialId), eq(credential.projectId, projectId)),
      ),
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
    where: relationalFilter(and(eq(provider.id, id), eq(provider.projectId, projectId))),
  });
  if (!existing) {
    return c.json({ error: { message: "Provider not found" } }, 404);
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(modelDeployment)
        .where(and(eq(modelDeployment.providerId, id), eq(modelDeployment.projectId, projectId)))
        .run();
      await tx
        .delete(provider)
        .where(and(eq(provider.id, id), eq(provider.projectId, projectId)))
        .run();
      await tx
        .insert(auditLog)
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
    if (isDatabaseConstraint(error, "foreign-key")) {
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

  clearProviderRoutingState(projectId, id);
  return c.json({ success: true });
});

export default providers;
