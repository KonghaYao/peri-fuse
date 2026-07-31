/**
 * Authentication middleware for PeriGateway.
 *
 * Proxy auth uses the SAME mechanism as the Peri-Fuse server:
 *   Authorization: Basic <base64(publicKey:secretKey)>
 * Verification is done against the shared database (api_keys table),
 * using SHA-256 fast path + bcrypt slow path — identical to server/src/auth.ts.
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
// Basic auth parsing
// ---------------------------------------------------------------------------

function extractBasicAuth(header: string | undefined): { publicKey: string; secretKey: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return { publicKey: decoded.slice(0, idx), secretKey: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proxy auth middleware
// ---------------------------------------------------------------------------

export async function proxyAuth(c: Context<GatewayEnv>, next: Next): Promise<Response | void> {
  const authHeader = c.req.header("authorization");
  const creds = extractBasicAuth(authHeader);

  if (!creds) {
    return c.json(
      { error: { message: "Missing or invalid Authorization header. Use Basic auth (publicKey:secretKey).", type: "authentication_error" } },
      401,
    );
  }

  const { publicKey, secretKey } = creds;

  // Check cache
  const cacheKey = `${publicKey}:${secretKey}`;
  const cached = authCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    c.set("apiKeyId", cached.publicKey);
    c.set("apiKeyPrefix", cached.publicKey);
    // Look up gateway config
    const gwConfig = await getGatewayConfig(cached.publicKey);
    c.set("apiKeyRecord", gwConfig);
    return next();
  }

  // Verify against shared DB
  const db = getSharedDb();
  const salt = process.env.SALT;

  let apiKey: any = null;

  // Fast path: SHA-256 hash lookup
  if (salt) {
    const fastHash = createShaHash(secretKey, salt);
    apiKey = (await db.$queryRawUnsafe(
      `SELECT id, public_key, project_id, expires_at FROM api_keys WHERE fast_hashed_secret_key = ? LIMIT 1`,
      fastHash,
    ) as any[])[0] ?? null;
  }

  // Slow path: bcrypt comparison
  if (!apiKey) {
    const rows: any[] = await db.$queryRawUnsafe(
      `SELECT id, public_key, hashed_secret_key, project_id, expires_at FROM api_keys WHERE public_key = ? LIMIT 1`,
      publicKey,
    );
    const row = rows[0];
    if (!row) {
      return c.json({ error: { message: "Invalid credentials", type: "authentication_error" } }, 401);
    }

    const isValid = await compare(secretKey, row.hashed_secret_key);
    if (!isValid) {
      return c.json({ error: { message: "Invalid credentials", type: "authentication_error" } }, 401);
    }

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
  }

  // Check expiry
  if (apiKey.expires_at && new Date(apiKey.expires_at).getTime() < Date.now()) {
    return c.json({ error: { message: "API key is expired", type: "authentication_error" } }, 401);
  }

  const resolvedPublicKey = apiKey.public_key ?? apiKey.publicKey ?? publicKey;
  const projectId = apiKey.project_id ?? apiKey.projectId ?? null;

  // Cache the auth result
  authCache.set(cacheKey, { publicKey: resolvedPublicKey, projectId, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });

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
