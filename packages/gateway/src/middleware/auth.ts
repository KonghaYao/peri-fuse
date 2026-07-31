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
import { compare } from "bcryptjs";
import type { Context, Next } from "hono";
import { PrismaClient } from "../generated/prisma/index.js";
import { getDb } from "../db.js";
import { gatewayEnv } from "../env.js";
import type { GatewayEnv } from "../app.js";

// ---------------------------------------------------------------------------
// Shared DB connection (for auth verification against server's api_keys)
// ---------------------------------------------------------------------------

let sharedDb: PrismaClient | null = null;

function getSharedDb(): PrismaClient {
  if (sharedDb) return sharedDb;

  const rawUrl = process.env.DATABASE_URL ?? "file:./.langfuse/langfuse.db";
  let datasourceUrl: string;
  if (rawUrl.startsWith("file:") && !rawUrl.startsWith("file:/")) {
    const relPath = rawUrl.slice("file:".length);
    datasourceUrl = `file:${resolve(process.cwd(), relPath)}`;
  } else {
    datasourceUrl = rawUrl;
  }

  sharedDb = new PrismaClient({ datasourceUrl });
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

  let apiKey: any = null;

  // Fast path: SHA-256 hash lookup (no public key needed)
  if (salt) {
    const fastHash = createShaHash(secretKey, salt);
    apiKey = (await db.$queryRawUnsafe(
      `SELECT id, public_key, project_id, expires_at FROM api_keys WHERE fast_hashed_secret_key = ? LIMIT 1`,
      fastHash,
    ) as any[])[0] ?? null;
  }

  // Slow path: bcrypt comparison across all keys
  if (!apiKey) {
    const rows: any[] = await db.$queryRawUnsafe(
      `SELECT id, public_key, hashed_secret_key, fast_hashed_secret_key, project_id, expires_at FROM api_keys LIMIT 100`,
    );
    for (const row of rows) {
      const isValid = await compare(secretKey, row.hashed_secret_key);
      if (isValid) {
        // Backfill fast hash for future requests
        if (salt && !row.fast_hashed_secret_key) {
          const shaHash = createShaHash(secretKey, salt);
          await db.$executeRawUnsafe(
            `UPDATE api_keys SET fast_hashed_secret_key = ? WHERE id = ?`,
            shaHash,
            row.id,
          ).catch(() => {});
        }
        apiKey = row;
        break;
      }
    }

    if (!apiKey) {
      return c.json({ error: { message: "Invalid secret key", type: "authentication_error" } }, 401);
    }
  }

  // Check expiry
  if (apiKey.expires_at && new Date(apiKey.expires_at).getTime() < Date.now()) {
    return c.json({ error: { message: "API key is expired", type: "authentication_error" } }, 401);
  }

  const resolvedPublicKey = apiKey.public_key ?? apiKey.publicKey;
  const projectId = apiKey.project_id ?? apiKey.projectId ?? null;

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
  const config = await db.apiKey.findUnique({ where: { publicKey } });

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
