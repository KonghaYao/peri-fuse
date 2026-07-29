/**
 * Management API routes — project and API key CRUD.
 *
 * These endpoints do NOT require pk/sk authentication. They are intended for
 * the local web UI to manage projects and keys. In a lite server context the
 * server runs locally so no additional auth layer is needed.
 */
import { prisma } from "@peri-fuse/shared/src/db";
import { createAndAddApiKeysToDb } from "@peri-fuse/shared/src/server/auth/apiKeys";
import { Hono } from "hono";

const manage = new Hono();

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

manage.get("/api/manage/projects", async (c) => {
  const projects = await prisma.project.findMany({
    where: { deletedAt: null },
    include: {
      organization: { select: { name: true } },
      _count: { select: { apiKeys: { where: { scope: "PROJECT" } } } },
    },
    orderBy: { createdAt: "asc" },
  });

  return c.json(
    projects.map((p) => ({
      id: p.id,
      name: p.name,
      orgName: p.organization?.name ?? "",
      keyCount: p._count.apiKeys,
      createdAt: p.createdAt.toISOString(),
    })),
  );
});

manage.post("/api/manage/projects", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim();
  if (!name) {
    return c.json({ message: "Project name is required" }, 400);
  }

  // Reuse the first org or create a default one
  let org = await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } });
  if (!org) {
    org = await prisma.organization.create({ data: { name: "Default Org" } });
  }

  const project = await prisma.project.create({
    data: { name, orgId: org.id },
    include: { organization: { select: { name: true } } },
  });

  return c.json(
    {
      id: project.id,
      name: project.name,
      orgName: project.organization?.name ?? "",
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

  const keys = await prisma.apiKey.findMany({
    where: { projectId, scope: "PROJECT" },
    orderBy: { createdAt: "asc" },
  });

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
  const project = await prisma.project.findUnique({ where: { id: projectId } });
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

  const key = await prisma.apiKey.findUnique({ where: { id: keyId } });
  if (!key) {
    return c.json({ message: "API key not found" }, 404);
  }

  await prisma.apiKey.delete({ where: { id: keyId } });
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Activate — used by the web UI to obtain usable credentials for a project
// ---------------------------------------------------------------------------

manage.post("/api/manage/projects/:id/activate", async (c) => {
  const projectId = c.req.param("id");

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return c.json({ message: "Project not found" }, 404);
  }

  // Delete any previous web-ui key (its sk is hashed, cannot be recovered)
  await prisma.apiKey.deleteMany({
    where: { projectId, scope: "PROJECT", note: "web-ui" },
  });

  // Create a fresh key for the web UI
  const result = await createAndAddApiKeysToDb({
    prisma,
    entityId: projectId,
    scope: "PROJECT",
    note: "web-ui",
  });

  return c.json({
    projectId: project.id,
    projectName: project.name,
    publicKey: result.publicKey,
    secretKey: result.secretKey,
  });
});

export default manage;
