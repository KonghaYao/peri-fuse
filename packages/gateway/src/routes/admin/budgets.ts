/**
 * Admin API — Budget CRUD (project-scoped).
 */
import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { GatewayEnv } from "../../app.js";
import { apiKey, auditLog, budget } from "../../db/schema.js";
import { getDb } from "../../db.js";
import { generateId } from "../../utils/id.js";

const budgets = new Hono<GatewayEnv>();

// List all budgets for the current project
budgets.get("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const items = await db.query.budget.findMany({
    where: eq(budget.projectId, projectId),
    orderBy: [desc(budget.createdAt)],
  });

  const withCounts = await Promise.all(
    items.map(async (b) => {
      const [row] = await db
        .select({ value: count() })
        .from(apiKey)
        .where(and(eq(apiKey.budgetId, b.id), eq(apiKey.projectId, projectId)));
      return {
        ...b,
        modelMaxBudget: b.modelMaxBudget ? JSON.parse(b.modelMaxBudget) : null,
        keyCount: row?.value ?? 0,
      };
    }),
  );

  return c.json({ data: withCounts });
});

// Get single budget
budgets.get("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const found = await db.query.budget.findFirst({
    where: and(eq(budget.id, c.req.param("id")), eq(budget.projectId, projectId)),
    with: {
      keys: {
        where: eq(apiKey.projectId, projectId),
        columns: { id: true, keyName: true, publicKey: true, spend: true },
      },
    },
  });

  if (!found) {
    return c.json({ error: { message: "Budget not found" } }, 404);
  }

  return c.json({
    ...found,
    modelMaxBudget: found.modelMaxBudget ? JSON.parse(found.modelMaxBudget) : null,
  });
});

// Create budget
budgets.post("/", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const body = await c.req.json();

  const [created] = await db
    .insert(budget)
    .values({
      id: generateId(),
      projectId,
      maxBudget: body.maxBudget ?? null,
      softBudget: body.softBudget ?? null,
      maxParallel: body.maxParallel ?? null,
      tpmLimit: body.tpmLimit ?? null,
      rpmLimit: body.rpmLimit ?? null,
      duration: body.duration ?? null,
      resetAt: body.duration ? computeNextReset(body.duration) : null,
      modelMaxBudget: body.modelMaxBudget ? JSON.stringify(body.modelMaxBudget) : null,
    })
    .returning();

  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "create",
    tableName: "Budget",
    objectId: created.id,
    afterValue: JSON.stringify({ maxBudget: created.maxBudget, duration: created.duration }),
    changedBy: "admin",
  });

  return c.json(created, 201);
});

// Update budget
budgets.put("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.query.budget.findFirst({
    where: and(eq(budget.id, id), eq(budget.projectId, projectId)),
  });
  if (!existing) {
    return c.json({ error: { message: "Budget not found" } }, 404);
  }

  const data: any = {};
  if (body.maxBudget !== undefined) data.maxBudget = body.maxBudget;
  if (body.softBudget !== undefined) data.softBudget = body.softBudget;
  if (body.maxParallel !== undefined) data.maxParallel = body.maxParallel;
  if (body.tpmLimit !== undefined) data.tpmLimit = body.tpmLimit;
  if (body.rpmLimit !== undefined) data.rpmLimit = body.rpmLimit;
  if (body.duration !== undefined) {
    data.duration = body.duration;
    data.resetAt = body.duration ? computeNextReset(body.duration) : null;
  }
  if (body.modelMaxBudget !== undefined) {
    data.modelMaxBudget = body.modelMaxBudget ? JSON.stringify(body.modelMaxBudget) : null;
  }

  const [updated] = await db
    .update(budget)
    .set(data)
    .where(and(eq(budget.id, id), eq(budget.projectId, projectId)))
    .returning();

  await db.insert(auditLog).values({
    id: generateId(),
    projectId,
    action: "update",
    tableName: "Budget",
    objectId: id,
    beforeValue: JSON.stringify({ maxBudget: existing.maxBudget }),
    afterValue: JSON.stringify({ maxBudget: updated.maxBudget }),
    changedBy: "admin",
  });

  return c.json(updated);
});

// Delete budget
budgets.delete("/:id", async (c) => {
  const db = getDb();
  const projectId = c.get("projectId");
  const id = c.req.param("id");

  const existing = await db.query.budget.findFirst({
    where: and(eq(budget.id, id), eq(budget.projectId, projectId)),
  });
  if (!existing) {
    return c.json({ error: { message: "Budget not found" } }, 404);
  }

  try {
    db.transaction((tx) => {
      tx.update(apiKey)
        .set({ budgetId: null })
        .where(and(eq(apiKey.budgetId, id), eq(apiKey.projectId, projectId)))
        .run();
      tx.delete(budget)
        .where(and(eq(budget.id, id), eq(budget.projectId, projectId)))
        .run();
      tx.insert(auditLog)
        .values({
          id: generateId(),
          projectId,
          action: "delete",
          tableName: "Budget",
          objectId: id,
          beforeValue: JSON.stringify({
            maxBudget: existing.maxBudget,
            duration: existing.duration,
          }),
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
        `[peri-gateway] Refused budget deletion for project ${projectId}, budget ${id}:`,
        error,
      );
      return c.json(
        { error: { message: "Budget cannot be deleted while API keys reference it" } },
        409,
      );
    }
    throw error;
  }

  return c.json({ success: true });
});

function computeNextReset(duration: string): string {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) return new Date(Date.now() + 86400000).toISOString();
  const value = parseInt(match[1], 10);
  const unit = match[2];
  let ms = 0;
  switch (unit) {
    case "d":
      ms = value * 86400000;
      break;
    case "h":
      ms = value * 3600000;
      break;
    case "m":
      ms = value * 60000;
      break;
  }
  return new Date(Date.now() + ms).toISOString();
}

export default budgets;
