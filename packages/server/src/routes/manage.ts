/**
 * Management API routes — project and API key CRUD.
 *
 * These endpoints do NOT require pk/sk authentication. They are intended for
 * the local web UI to manage projects and keys. In a lite server context the
 * server runs locally so no additional auth layer is needed.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@peri-fuse/shared/src/db";
import { apiKeys, organizations, projects } from "@peri-fuse/shared/src/db/schema/index.js";
import { createAndAddApiKeysToDb } from "@peri-fuse/shared/src/server/auth/apiKeys";
import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";

const manage = new Hono();

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

manage.get("/api/manage/projects", async (c) => {
  const rows = await prisma.query.projects.findMany({
    where: isNull(projects.deletedAt),
    with: { organization: true },
    orderBy: asc(projects.createdAt),
  });

  const withCounts = await Promise.all(
    rows.map(async (p) => {
      const keyCount = await prisma
        .select({ value: count() })
        .from(apiKeys)
        .where(and(eq(apiKeys.projectId, p.id), eq(apiKeys.scope, "PROJECT")))
        .then((r) => r[0]?.value ?? 0);
      return {
        id: p.id,
        name: p.name,
        orgName: p.organization?.name ?? "",
        keyCount,
        createdAt: p.createdAt.toISOString(),
      };
    }),
  );

  return c.json(withCounts);
});

manage.post("/api/manage/projects", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!name) {
    return c.json({ message: "Project name is required" }, 400);
  }

  // Reuse the first org or create a default one
  let org = await prisma
    .select()
    .from(organizations)
    .orderBy(asc(organizations.createdAt))
    .limit(1)
    .then((rows) => rows[0]);
  if (!org) {
    org = await prisma
      .insert(organizations)
      .values({ id: randomUUID(), name: "Default Org" })
      .returning()
      .then((rows) => rows[0]);
  }

  const project = await prisma
    .insert(projects)
    .values({ id: randomUUID(), name, orgId: org.id })
    .returning()
    .then((rows) => rows[0]);

  const orgName =
    (await prisma
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, org.id))
      .then((rows) => rows[0]?.name)) ?? "";

  return c.json(
    {
      id: project.id,
      name: project.name,
      orgName,
      createdAt: project.createdAt.toISOString(),
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

manage.get("/api/manage/projects/:id/keys", async (c) => {
  const projectId = c.req.param("id");

  const keys = await prisma
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.projectId, projectId), eq(apiKeys.scope, "PROJECT")))
    .orderBy(asc(apiKeys.createdAt));

  return c.json(
    keys.map((k) => ({
      id: k.id,
      publicKey: k.publicKey,
      displaySecretKey: k.displaySecretKey,
      note: k.note,
      createdAt: k.createdAt.toISOString(),
    })),
  );
});

manage.post("/api/manage/projects/:id/keys", async (c) => {
  const projectId = c.req.param("id");

  // Verify project exists
  const project = await prisma
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!project) {
    return c.json({ message: "Project not found" }, 404);
  }

  const result = await createAndAddApiKeysToDb({
    prisma,
    entityId: projectId,
    scope: "PROJECT",
    note: "Created via UI",
  });

  return c.json(
    {
      id: result.id,
      publicKey: result.publicKey,
      secretKey: result.secretKey,
      displaySecretKey: result.displaySecretKey,
    },
    201,
  );
});

manage.delete("/api/manage/keys/:id", async (c) => {
  const keyId = c.req.param("id");

  const key = await prisma
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!key) {
    return c.json({ message: "API key not found" }, 404);
  }

  await prisma.delete(apiKeys).where(eq(apiKeys.id, keyId));
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Activate — used by the web UI to obtain usable credentials for a project
// ---------------------------------------------------------------------------

/** How many concurrent web-ui keys a project may keep before pruning. */
const MAX_WEB_UI_KEYS = 5;

manage.post("/api/manage/projects/:id/activate", async (c) => {
  const projectId = c.req.param("id");

  const project = await prisma
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!project) {
    return c.json({ message: "Project not found" }, 404);
  }

  // Create a fresh key for the web UI. Previous web-ui keys stay valid so
  // already-open sessions (other tabs, other origins, reopened laptop lids)
  // keep authenticating; only the oldest ones beyond the cap are pruned.
  const result = await createAndAddApiKeysToDb({
    prisma,
    entityId: projectId,
    scope: "PROJECT",
    note: "web-ui",
  });

  const webUiKeys = await prisma
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.projectId, projectId),
        eq(apiKeys.scope, "PROJECT"),
        eq(apiKeys.note, "web-ui"),
      ),
    )
    .orderBy(desc(apiKeys.createdAt));
  const staleIds = webUiKeys.slice(MAX_WEB_UI_KEYS).map((k) => k.id);
  if (staleIds.length > 0) {
    await prisma.delete(apiKeys).where(inArray(apiKeys.id, staleIds));
  }

  return c.json({
    projectId: project.id,
    projectName: project.name,
    publicKey: result.publicKey,
    secretKey: result.secretKey,
  });
});

export default manage;
