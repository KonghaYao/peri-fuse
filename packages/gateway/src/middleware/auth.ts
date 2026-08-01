/**
 * Unified authentication middleware for PeriGateway.
 *
 * All routes (proxy + admin) use the same project-scoped API key auth:
 *   - Authorization: Bearer <secretKey>   (existing proxy clients)
 *   - Authorization: Basic <base64(pk:sk)> (server-compatible)
 *
 * The key is verified against the shared server database (api_keys table).
 * Only PROJECT-scoped keys are accepted; the resolved projectId is injected
 * into the Hono context for downstream resource isolation.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { compare } from "bcryptjs";
import type { Context, Next } from "hono";
import { getDb } from "../db.js";
import { apiKey } from "../db/schema.js";
import type { GatewayEnv } from "../app.js";

// ---------------------------------------------------------------------------
// Shared DB connection (for auth verification against server's api_keys)
// ---------------------------------------------------------------------------

let sharedDb: Database.Database | null = null;

function getSharedDb(): Database.Database {
  if (sharedDb) return sharedDb;

  const rawUrl = process.env.DATABASE_URL ?? "file:./.langfuse/langfuse.db";
  let dbPath: string;
  if (rawUrl.startsWith("file:")) {
    const rawPath = rawUrl.slice("file:".length);
    dbPath = rawPath.startsWith("/") ? rawPath : resolve(process.cwd(), rawPath);
  } else {
    dbPath = rawUrl;
  }

  sharedDb = new Database(dbPath, { readonly: false });
  sharedDb.pragma("busy_timeout = 5000");
  return sharedDb;
}

// ---------------------------------------------------------------------------
// Hash utilities (same as @peri-fuse/shared/src/server/auth/apiKeys.ts)
// ---------------------------------------------------------------------------

function createShaHash(privateKey: string, salt: string): string {
  return createHash("sha256")
    .update(privateKey)
    .update(createHash("sha256").update(salt, "utf8").digest("hex"))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory auth cache
// ---------------------------------------------------------------------------

interface CachedAuth {
  publicKey: string;
  projectId: string;
  orgId: string;
  expiresAt: number;
}

const authCache = new Map<string, CachedAuth>();
const AUTH_CACHE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Credential extraction
// ---------------------------------------------------------------------------

function extractBearerToken(header: string): string | null {
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function extractBasicCredentials(header: string): { publicKey: string; secretKey: string } | null {
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return null;
    const publicKey = decoded.slice(0, colonIdx);
    const secretKey = decoded.slice(colonIdx + 1);
    if (!publicKey || !secretKey) return null;
    return { publicKey, secretKey };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Unified auth middleware
// ---------------------------------------------------------------------------

export async function unifiedAuth(c: Context<GatewayEnv>, next: Next): Promise<Response | void> {
  const authHeader = c.req.header("authorization");

  if (!authHeader) {
    return c.json(
      { error: { message: "Missing Authorization header. Use Bearer <secretKey> or Basic <base64(pk:sk)>.", type: "authentication_error" } },
      401,
    );
  }

  // Determine secret key from either Bearer or Basic format
  let secretKey: string | null = null;
  let hintPublicKey: string | null = null;

  const bearerToken = extractBearerToken(authHeader);
  if (bearerToken) {
    secretKey = bearerToken;
  } else {
    const basic = extractBasicCredentials(authHeader);
    if (basic) {
      secretKey = basic.secretKey;
      hintPublicKey = basic.publicKey;
    }
  }

  if (!secretKey) {
    return c.json(
      { error: { message: "Invalid Authorization header format. Use Bearer <sk> or Basic <base64(pk:sk)>.", type: "authentication_error" } },
      401,
    );
  }

  // Check cache
  const cached = authCache.get(secretKey);
  if (cached && cached.expiresAt > Date.now()) {
    c.set("projectId", cached.projectId);
    c.set("orgId", cached.orgId);
    c.set("apiKeyId", cached.publicKey);
    c.set("apiKeyPrefix", cached.publicKey);
    const gwConfig = await getGatewayConfig(cached.publicKey, cached.projectId);
    c.set("apiKeyRecord", gwConfig);
    return next();
  }

  // Verify against shared DB
  const db = getSharedDb();
  const salt = process.env.SALT;

  let apiKeyRow: any = null;

  // Fast path: SHA-256 hash lookup
  if (salt) {
    const fastHash = createShaHash(secretKey, salt);
    apiKeyRow =
      (db
        .prepare(
          `SELECT id, public_key, project_id, organization_id, scope, expires_at FROM api_keys WHERE fast_hashed_secret_key = ? LIMIT 1`,
        )
        .get(fastHash) as any) ?? null;
  }

  // If Basic auth provided a public key hint, try direct lookup
  if (!apiKeyRow && hintPublicKey) {
    apiKeyRow =
      (db
        .prepare(
          `SELECT id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id, organization_id, scope, expires_at FROM api_keys WHERE public_key = ? LIMIT 1`,
        )
        .get(hintPublicKey) as any) ?? null;

    if (apiKeyRow) {
      const isValid = await compare(secretKey, apiKeyRow.hashed_secret_key);
      if (!isValid) {
        return c.json({ error: { message: "Invalid credentials", type: "authentication_error" } }, 401);
      }
      // Backfill fast hash
      if (salt && !apiKeyRow.fast_hashed_secret_key) {
        const shaHash = createShaHash(secretKey, salt);
        try {
          db.prepare(`UPDATE api_keys SET fast_hashed_secret_key = ? WHERE id = ?`).run(shaHash, apiKeyRow.id);
        } catch { /* ignore */ }
      }
    }
  }

  // Slow path: bcrypt comparison across all keys (fallback)
  if (!apiKeyRow) {
    const rows = db
      .prepare(
        `SELECT id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id, organization_id, scope, expires_at FROM api_keys LIMIT 100`,
      )
      .all() as any[];
    for (const row of rows) {
      const isValid = await compare(secretKey, row.hashed_secret_key);
      if (isValid) {
        // Backfill fast hash for future requests
        if (salt && !row.fast_hashed_secret_key) {
          const shaHash = createShaHash(secretKey, salt);
          try {
            db.prepare(`UPDATE api_keys SET fast_hashed_secret_key = ? WHERE id = ?`).run(shaHash, row.id);
          } catch { /* ignore */ }
        }
        apiKeyRow = row;
        break;
      }
    }

    if (!apiKeyRow) {
      return c.json({ error: { message: "Invalid secret key", type: "authentication_error" } }, 401);
    }
  }

  // Check expiry
  if (apiKeyRow.expires_at && new Date(apiKeyRow.expires_at).getTime() < Date.now()) {
    return c.json({ error: { message: "API key is expired", type: "authentication_error" } }, 401);
  }

  // Enforce PROJECT scope
  const scope = apiKeyRow.scope ?? "PROJECT";
  const projectId = apiKeyRow.project_id ?? apiKeyRow.projectId ?? null;
  const orgId = apiKeyRow.organization_id ?? apiKeyRow.organizationId ?? "";

  if (scope !== "PROJECT" || !projectId) {
    return c.json(
      { error: { message: "Gateway requires a PROJECT-scoped API key. Organization-level keys are not supported.", type: "authentication_error" } },
      403,
    );
  }

  const resolvedPublicKey = apiKeyRow.public_key ?? apiKeyRow.publicKey;

  // Cache the auth result
  authCache.set(secretKey, { publicKey: resolvedPublicKey, projectId, orgId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });

  // Look up gateway-specific config (rate limits, budget)
  const gwConfig = await getGatewayConfig(resolvedPublicKey, projectId);

  c.set("projectId", projectId);
  c.set("orgId", orgId);
  c.set("apiKeyId", resolvedPublicKey);
  c.set("apiKeyPrefix", resolvedPublicKey);
  c.set("apiKeyRecord", gwConfig);

  return next();
}

/**
 * Look up gateway-side config for a publicKey within a project.
 * Returns a record compatible with the hook system, with defaults if no config exists.
 */
async function getGatewayConfig(publicKey: string, projectId: string) {
  const db = getDb();
  const config = await db.query.apiKey.findFirst({ where: eq(apiKey.publicKey, publicKey) });

  if (!config) {
    // No gateway-specific config — return defaults (unlimited)
    return {
      id: publicKey,
      publicKey,
      projectId,
      spend: 0,
      models: "[]",
      maxParallel: null,
      tpmLimit: null,
      rpmLimit: null,
      maxBudget: null,
      budgetId: null,
      metadata: "{}",
      isEnabled: true,
    };
  }

  return config;
}
