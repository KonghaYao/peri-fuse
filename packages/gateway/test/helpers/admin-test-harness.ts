import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import type { Hono } from "hono";

export const PROJECT_A = "project-admin-a";
export const PROJECT_B = "project-admin-b";
export const PUBLIC_KEY_A = "pk-admin-a";
export const PUBLIC_KEY_B = "pk-admin-b";
export const SECRET_KEY_A = "sk-admin-a";
export const SECRET_KEY_B = "sk-admin-b";

const ORG_A = "org-admin-a";
const ORG_B = "org-admin-b";
const TEST_SALT = "admin-project-isolation-salt";
const GATEWAY_DB = "/tmp/peri-gateway-admin-scope.db";
const SHARED_DB = "/tmp/peri-gateway-admin-shared.db";

type Project = "A" | "B";

export interface AdminTestHarness {
  app: Hono;
  close(): Promise<void>;
  seedBudgetKeyConfig(
    id: string,
    projectId: string,
    publicKey: string,
    budgetId: string,
  ): Promise<void>;
  seedGatewayKeyConfig(projectId: string, publicKey: string): Promise<string>;
  seedModelDeployment(
    id: string,
    projectId: string,
    providerId: string,
    modelName: string,
  ): Promise<void>;
  request(
    project: Project,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }>;
}

function removeSqliteFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${path}${suffix}`;
    if (existsSync(file)) unlinkSync(file);
  }
}

function fastHash(secretKey: string): string {
  return createHash("sha256")
    .update(secretKey)
    .update(createHash("sha256").update(TEST_SALT, "utf8").digest("hex"))
    .digest("hex");
}

function seedSharedApiKeys(): void {
  const shared = new DatabaseSync(SHARED_DB);
  shared.exec(`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL UNIQUE,
      hashed_secret_key TEXT NOT NULL,
      fast_hashed_secret_key TEXT,
      project_id TEXT,
      organization_id TEXT,
      scope TEXT DEFAULT 'PROJECT',
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const insert = shared.prepare(`
    INSERT INTO api_keys (
      id, public_key, hashed_secret_key, fast_hashed_secret_key,
      project_id, organization_id, scope
    ) VALUES (?, ?, ?, ?, ?, ?, 'PROJECT')
  `);
  insert.run(
    "key-admin-a",
    PUBLIC_KEY_A,
    bcrypt.hashSync(SECRET_KEY_A, 4),
    fastHash(SECRET_KEY_A),
    PROJECT_A,
    ORG_A,
  );
  insert.run(
    "key-admin-b",
    PUBLIC_KEY_B,
    bcrypt.hashSync(SECRET_KEY_B, 4),
    fastHash(SECRET_KEY_B),
    PROJECT_B,
    ORG_B,
  );
  shared.close();
}

export async function createAdminTestHarness(): Promise<AdminTestHarness> {
  removeSqliteFiles(GATEWAY_DB);
  removeSqliteFiles(SHARED_DB);

  process.env.GATEWAY_DB_URL = `file:${GATEWAY_DB}`;
  process.env.DATABASE_URL = `file:${SHARED_DB}`;
  process.env.SALT = TEST_SALT;
  process.env.GATEWAY_ENCRYPTION_KEY = "a".repeat(64);

  seedSharedApiKeys();

  const { ensureSchema } = await import("../../src/db.js");
  const { createApp } = await import("../../src/app.js");
  ensureSchema();
  const app = createApp();

  return {
    app,
    async seedBudgetKeyConfig(id, projectId, publicKey, budgetId) {
      const { getDb } = await import("../../src/db.js");
      const { apiKey } = await import("../../src/db/schema.js");
      await getDb().insert(apiKey).values({ id, projectId, publicKey, budgetId });
    },
    async seedGatewayKeyConfig(projectId, publicKey) {
      const { getDb } = await import("../../src/db.js");
      const { apiKey } = await import("../../src/db/schema.js");
      const id = `seeded-key-${projectId}-${publicKey}`;
      await getDb().insert(apiKey).values({ id, projectId, publicKey });
      return id;
    },
    async seedModelDeployment(id, projectId, providerId, modelName) {
      const { getDb } = await import("../../src/db.js");
      const { modelDeployment } = await import("../../src/db/schema.js");
      await getDb()
        .insert(modelDeployment)
        .values({
          id,
          projectId,
          providerId,
          modelName,
          providerModel: `${modelName}-provider-model`,
        });
    },
    async request(project, method, path, body) {
      const secretKey = project === "A" ? SECRET_KEY_A : SECRET_KEY_B;
      const response = await app.request(path, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      const { closeDb } = await import("../../src/db.js");
      closeDb();
    },
  };
}
