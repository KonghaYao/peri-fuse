/**
 * Admin API — Budget CRUD.
 */
import { Hono } from "hono";
import { getDb } from "../../db.js";

const budgets = new Hono();

// List all budgets
budgets.get("/", async (c) => {
  const db = getDb();
  const items = await db.budget.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { keys: true } } },
  });

  const safe = items.map((b) => ({
    ...b,
    modelMaxBudget: b.modelMaxBudget ? JSON.parse(b.modelMaxBudget) : null,
    keyCount: b._count.keys,
    _count: undefined,
  }));

  return c.json({ data: safe });
});

// Get single budget
budgets.get("/:id", async (c) => {
  const db = getDb();
  const budget = await db.budget.findUnique({
    where: { id: c.req.param("id") },
    include: { keys: { select: { id: true, keyName: true, publicKey: true, spend: true } } },
  });

  if (!budget) {
    return c.json({ error: { message: "Budget not found" } }, 404);
  }

  return c.json({
    ...budget,
    modelMaxBudget: budget.modelMaxBudget ? JSON.parse(budget.modelMaxBudget) : null,
  });
});

// Create budget
budgets.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.json();

  const budget = await db.budget.create({
    data: {
      maxBudget: body.maxBudget ?? null,
      softBudget: body.softBudget ?? null,
      maxParallel: body.maxParallel ?? null,
      tpmLimit: body.tpmLimit ?? null,
      rpmLimit: body.rpmLimit ?? null,
      duration: body.duration ?? null,
      resetAt: body.duration ? computeNextReset(body.duration) : null,
      modelMaxBudget: body.modelMaxBudget ? JSON.stringify(body.modelMaxBudget) : null,
    },
  });

  await db.auditLog.create({
    data: {
      action: "create",
      tableName: "Budget",
      objectId: budget.id,
      afterValue: JSON.stringify({ maxBudget: budget.maxBudget, duration: budget.duration }),
      changedBy: "admin",
    },
  });

  return c.json(budget, 201);
});

// Update budget
budgets.put("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.budget.findUnique({ where: { id } });
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

  const budget = await db.budget.update({ where: { id }, data });

  await db.auditLog.create({
    data: {
      action: "update",
      tableName: "Budget",
      objectId: id,
      beforeValue: JSON.stringify({ maxBudget: existing.maxBudget }),
      afterValue: JSON.stringify({ maxBudget: budget.maxBudget }),
      changedBy: "admin",
    },
  });

  return c.json(budget);
});

// Delete budget
budgets.delete("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");

  const existing = await db.budget.findUnique({ where: { id } });
  if (!existing) {
    return c.json({ error: { message: "Budget not found" } }, 404);
  }

  // Unlink keys first
  await db.apiKey.updateMany({ where: { budgetId: id }, data: { budgetId: null } });
  await db.budget.delete({ where: { id } });

  await db.auditLog.create({
    data: {
      action: "delete",
      tableName: "Budget",
      objectId: id,
      beforeValue: JSON.stringify({ maxBudget: existing.maxBudget, duration: existing.duration }),
      changedBy: "admin",
    },
  });

  return c.json({ success: true });
});

function computeNextReset(duration: string): Date {
  const match = duration.match(/^(\d+)([dhm])$/);
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

export default budgets;
