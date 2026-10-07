import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  applyLocalMigrations,
  openLocalDatabase,
  readLocalMigrations,
} from "@peri-fuse/shared/src/db/local";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRemoteTestServer } from "../../shared/src/db/__tests__/remote-test-server";
import { closeSharedApiKeyDb, getSharedApiKeyDb } from "../src/auth/shared-api-key-store";
import { closeDb, ensureSchema } from "../src/db";

let server: Awaited<ReturnType<typeof startRemoteTestServer>>;
let app: ReturnType<typeof import("../src/app").createApp>;
const salt = "remote-storage-salt";
const hash = (secret: string) =>
  createHash("sha256")
    .update(secret)
    .update(createHash("sha256").update(salt).digest("hex"))
    .digest("hex");
const basic = (role: string) =>
  `Basic ${Buffer.from(`pk-remote-${role}:sk-remote-${role}`).toString("base64")}`;

beforeAll(async () => {
  server = await startRemoteTestServer();
  vi.stubEnv("TURSO_DATABASE_URL", server.url);
  vi.stubEnv("TURSO_AUTH_TOKEN", server.authToken);
  vi.stubEnv("SALT", salt);
  vi.stubEnv("PERIFUSE_HOME", server.directory);
  const metadata = await openLocalDatabase(server.url, false, server.authToken);
  try {
    await applyLocalMigrations(
      metadata,
      readLocalMigrations(resolve(__dirname, "../../shared/drizzle")),
    );
    await metadata.run(
      "INSERT INTO organizations(id,name,created_at,updated_at) VALUES(?,?,?,?)",
      "remote-org",
      "Remote org",
      Date.now(),
      Date.now(),
    );
    for (const role of ["a", "b"]) {
      await metadata.run(
        "INSERT INTO projects(id,org_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
        `remote-${role}`,
        "remote-org",
        role,
        Date.now(),
        Date.now(),
      );
      await metadata.run(
        "INSERT INTO api_keys(id,created_at,public_key,hashed_secret_key,fast_hashed_secret_key,display_secret_key,project_id,organization_id,scope) VALUES(?,?,?,?,?,?,?,?,?)",
        `remote-key-${role}`,
        Date.now(),
        `pk-remote-${role}`,
        await bcrypt.hash(`sk-remote-${role}`, 4),
        role === "a" ? null : hash(`sk-remote-${role}`),
        "masked",
        `remote-${role}`,
        "remote-org",
        "PROJECT",
      );
    }
    await metadata.run(
      "INSERT INTO api_keys(id,created_at,public_key,hashed_secret_key,fast_hashed_secret_key,display_secret_key,organization_id,scope) VALUES(?,?,?,?,?,?,?,?)",
      "remote-key-org",
      Date.now(),
      "pk-remote-org",
      await bcrypt.hash("sk-remote-org", 4),
      hash("sk-remote-org"),
      "masked",
      "remote-org",
      "ORGANIZATION",
    );
  } finally {
    await metadata.close();
  }
  await ensureSchema();
  const { createApp } = await import("../src/app");
  app = createApp();
});
afterAll(async () => {
  await closeSharedApiKeyDb();
  await closeDb();
  vi.unstubAllEnvs();
  await server?.close();
});

describe("Gateway remote Turso storage", () => {
  it("authenticates legacy Basic keys against remote metadata and persists fast hashes remotely", async () => {
    const response = await app.request("/admin/providers", {
      method: "POST",
      headers: { Authorization: basic("a"), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "remote-provider",
        type: "openai",
        baseUrl: "https://example.com/v1",
      }),
    });
    expect(response.status).toBe(201);
    const metadata = await getSharedApiKeyDb();
    expect(
      await metadata.get("SELECT fast_hashed_secret_key FROM api_keys WHERE id=?", "remote-key-a"),
    ).toEqual({ fast_hashed_secret_key: hash("sk-remote-a") });
  });
  it("keeps remote Gateway resources isolated between projects", async () => {
    const listA = await app.request("/admin/providers", {
      headers: { Authorization: "Bearer sk-remote-a" },
    });
    const body = (await listA.json()) as { data: { id: string; projectId: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].projectId).toBe("remote-a");
    const listB = await app.request("/admin/providers", { headers: { Authorization: basic("b") } });
    expect(await listB.json()).toEqual({ data: [] });
    const crossProject = await app.request(`/admin/providers/${body.data[0].id}`, {
      headers: { Authorization: basic("b") },
    });
    expect(crossProject.status).toBe(404);
    const forbidden = await app.request("/admin/providers", {
      headers: { Authorization: basic("org") },
    });
    expect(forbidden.status).toBe(403);
  });
});
