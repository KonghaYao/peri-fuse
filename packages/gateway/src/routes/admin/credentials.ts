/**
 * Admin API — Credential CRUD.
 */
import { count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../db.js";
import { auditLog, credential, provider } from "../../db/schema.js";
import { generateId } from "../../utils/id.js";
import { encrypt } from "../../utils/crypto.js";

const credentials = new Hono();

// List all credentials (never expose values)
credentials.get("/", async (c) => {
  const db = getDb();
  const items = await db.query.credential.findMany({ orderBy: [desc(credential.createdAt)] });

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

  const [created] = await db
    .insert(credential)
    .values({
      id: generateId(),
      name: body.name,
      values: encrypt(JSON.stringify(body.values)),
      info: body.info ? JSON.stringify(body.info) : null,
    })
    .returning();

  await db.insert(auditLog).values({
    id: generateId(),
    action: "create",
    tableName: "Credential",
    objectId: created.id,
    afterValue: JSON.stringify({ name: created.name }),
    changedBy: "admin",
  });

  return c.json({ id: created.id, name: created.name, createdAt: created.createdAt }, 201);
});

// Update credential
credentials.put("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await db.query.credential.findFirst({ where: eq(credential.id, id) });
  if (!existing) {
    return c.json({ error: { message: "Credential not found" } }, 404);
  }

  const data: any = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.values !== undefined) data.values = encrypt(JSON.stringify(body.values));
  if (body.info !== undefined) data.info = JSON.stringify(body.info);

  const [updated] = await db.update(credential).set(data).where(eq(credential.id, id)).returning();

  await db.insert(auditLog).values({
    id: generateId(),
    action: "update",
    tableName: "Credential",
    objectId: id,
    beforeValue: JSON.stringify({ name: existing.name }),
    afterValue: JSON.stringify({ name: updated.name }),
    changedBy: "admin",
  });

  return c.json({ id: updated.id, name: updated.name, updatedAt: updated.updatedAt });
});

// Delete credential
credentials.delete("/:id", async (c) => {
  const db = getDb();
  const id = c.req.param("id");

  const existing = await db.query.credential.findFirst({ where: eq(credential.id, id) });
  if (!existing) {
    return c.json({ error: { message: "Credential not found" } }, 404);
  }

  // Check if any provider references this credential
  const [refRow] = await db
    .select({ value: count() })
    .from(provider)
    .where(eq(provider.credentialId, id));
  const refs = refRow?.value ?? 0;
  if (refs > 0) {
    return c.json({ error: { message: `Credential is referenced by ${refs} provider(s)` } }, 409);
  }

  await db.delete(credential).where(eq(credential.id, id));

  await db.insert(auditLog).values({
    id: generateId(),
    action: "delete",
    tableName: "Credential",
    objectId: id,
    beforeValue: JSON.stringify({ name: existing.name }),
    changedBy: "admin",
  });

  return c.json({ success: true });
});

export default credentials;
