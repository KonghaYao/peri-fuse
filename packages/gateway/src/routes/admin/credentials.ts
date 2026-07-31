/**
 * Admin API — Credential CRUD.
 */
import { Hono } from "hono";
import { getDb } from "../../db.js";
import { encrypt } from "../../utils/crypto.js";

const credentials = new Hono();

// List all credentials (never expose values)
credentials.get("/", async (c) => {
  const db = getDb();
  const items = await db.credential.findMany({ orderBy: { createdAt: "desc" } });

  const safe = items.map((cr) => ({
    id: cr.id,
    name: cr.name,
    info: cr.info ? JSON.parse(cr.info) : null,
    createdAt: cr.createdAt,
    updatedAt: cr.updatedAt,
  }));

  return c.json({ data: safe });
});

// Create credential
credentials.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.json();

  if (!body.name || !body.values) {
    return c.json({ error: { message: "name and values are required" } }, 400);
  }

  const credential = await db.credential.create({
    data: {
      name: body.name,
      values: encrypt(JSON.stringify(body.values)),
      info: body.info ? JSON.stringify(body.info) : null,
    },
  });

  await db.auditLog.create({
    data: {
      action: "create",
      tableName: "Credential",
      objectId: credential.id,
      afterValue: JSON.stringify({ name: credential.name }),
      changedBy: "admin",
    },
  });

  return c.json({ id: credential.id, name: credential.name, createdAt: credential.createdAt }, 201);
});

// Update credential
credentials.put("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.credential.findUnique({ where: { id } });
  if (!existing) {
    return c.json({ error: { message: "Credential not found" } }, 404);
  }

  const data: any = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.values !== undefined) data.values = encrypt(JSON.stringify(body.values));
  if (body.info !== undefined) data.info = JSON.stringify(body.info);

  const credential = await db.credential.update({ where: { id }, data });

  await db.auditLog.create({
    data: {
      action: "update",
      tableName: "Credential",
      objectId: id,
      beforeValue: JSON.stringify({ name: existing.name }),
      afterValue: JSON.stringify({ name: credential.name }),
      changedBy: "admin",
    },
  });

  return c.json({ id: credential.id, name: credential.name, updatedAt: credential.updatedAt });
});

// Delete credential
credentials.delete("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");

  const existing = await db.credential.findUnique({ where: { id } });
  if (!existing) {
    return c.json({ error: { message: "Credential not found" } }, 404);
  }

  // Check if any provider references this credential
  const refs = await db.provider.count({ where: { credentialId: id } });
  if (refs > 0) {
    return c.json({ error: { message: `Credential is referenced by ${refs} provider(s)` } }, 409);
  }

  await db.credential.delete({ where: { id } });

  await db.auditLog.create({
    data: {
      action: "delete",
      tableName: "Credential",
      objectId: id,
      beforeValue: JSON.stringify({ name: existing.name }),
      changedBy: "admin",
    },
  });

  return c.json({ success: true });
});

export default credentials;
