/**
 * Authentication middleware for PeriGateway.
 *
 * Proxy auth uses ONLY the secret key (sk):
 *   Authorization: Bearer <secretKey>
 * The secret key is verified against the shared database (api_keys table)
 * via SHA-256 fast path + bcrypt slow path. No public key required.
 *
 * Admin auth remains a simple static key check (x-admin-key header).
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { compare } from "bcryptjs";
import type { Context, Next } from "hono";
import { getDb } from "../db.js";
import { apiKey } from "../db/schema.js";
import { gatewayEnv } from "../env.js";
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
  projectId: string | null;
  expiresAt: number;
}

const authCache = new Map<string, CachedAuth>();
const AUTH_CACHE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Bearer token (secret key) extraction
// ---------------------------------------------------------------------------

function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

// ---------------------------------------------------------------------------
// Proxy auth middleware
// ---------------------------------------------------------------------------

export async function proxyAuth(c: Context<GatewayEnv>, next: Next): Promise<Response | void> {
  const authHeader = c.req.header("authorization");
  const secretKey = extractBearerToken(authHeader);

  if (!secretKey) {
    return c.json(
      { error: { message: "Missing or invalid Authorization header. Use Bearer <secretKey>.", type: "authentication_error" } },
      401,
    );
  }

  // Check cache
  const cached = authCache.get(secretKey);
  if (cached && cached.expiresAt > Date.now()) {
    c.set("apiKeyId", cached.publicKey);
    c.set("apiKeyPrefix", cached.publicKey);
    const gwConfig = await getGatewayConfig(cached.publicKey);
    c.set("apiKeyRecord", gwConfig);
    return next();
  }

  // Verify against shared DB
  const db = getSharedDb();
  const salt = process.env.SALT;

  let apiKeyRow: any = null;

  // Fast path: SHA-256 hash lookup (no public key needed)
  if (salt) {
    const fastHash = createShaHash(secretKey, salt);
    apiKeyRow =
      (db
        .prepare(
          `SELECT id, public_key, project_id, expires_at FROM api_keys WHERE fast_hashed_secret_key = ? LIMIT 1`,
        )
        .get(fastHash) as any) ?? null;
  }

  // Slow path: bcrypt comparison across all keys
  if (!apiKeyRow) {
    const rows = db
      .prepare(
        `SELECT id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id, expires_at FROM api_keys LIMIT 100`,
      )
      .all() as any[];
    for (const row of rows) {
      const isValid = await compare(secretKey, row.hashed_secret_key);
      if (isValid) {
        // Backfill fast hash for future requests
        if (salt && !row.fast_hashed_secret_key) {
          const shaHash = createShaHash(secretKey, salt);
          try {
            db.prepare(`UPDATE api_keys SET fast_hashed_secret_key = ? WHERE id = ?`).run(
              shaHash,
              row.id,
            );
          } catch {
            // ignore backfill errors
          }
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

  const resolvedPublicKey = apiKeyRow.public_key ?? apiKeyRow.publicKey;
  const projectId = apiKeyRow.project_id ?? apiKeyRow.projectId ?? null;

  // Cache the auth result
  authCache.set(secretKey, { publicKey: resolvedPublicKey, projectId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });

  // Look up gateway-specific config (rate limits, budget)
  const gwConfig = await getGatewayConfig(resolvedPublicKey);

  c.set("apiKeyId", resolvedPublicKey);
  c.set("apiKeyPrefix", resolvedPublicKey);
  c.set("apiKeyRecord", gwConfig);

  return next();
}

/**
 * Look up gateway-side config for a publicKey. Returns a record compatible
 * with the hook system, with defaults if no config exists.
 */
async function getGatewayConfig(publicKey: string) {
  const db = getDb();
  const config = await db.query.apiKey.findFirst({ where: eq(apiKey.publicKey, publicKey) });

  if (!config) {
    // No gateway-specific config — return defaults (unlimited)
    return {
      id: publicKey,
      publicKey,
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

// ---------------------------------------------------------------------------
// Admin auth middleware (unchanged — static key)
// ---------------------------------------------------------------------------

export async function adminAuth(c: Context, next: Next): Promise<Response | void> {
  const adminKey = c.req.header("x-admin-key");

  if (adminKey !== gatewayEnv.adminKey) {
    return c.json({ error: { message: "Unauthorized", type: "authentication_error" } }, 401);
  }

  return next();
}
