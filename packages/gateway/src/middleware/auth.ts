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
import { compare } from "bcryptjs";
import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import type { GatewayEnv } from "../app.js";
import { getSharedApiKeyDb } from "../auth/shared-api-key-store.js";
import { apiKey } from "../db/schema.js";
import { getDb } from "../db.js";
import { BoundedTtlMap } from "../utils/bounded-ttl-map.js";

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

const AUTH_CACHE_TTL_MS = 30_000;
const authCache = new BoundedTtlMap<CachedAuth>(4096, AUTH_CACHE_TTL_MS);
const LEGACY_KEY_BATCH_SIZE = 25;
let legacyBearerScanInProgress = false;

interface LegacyApiKeyRow {
  id: string;
  public_key: string;
  hashed_secret_key: string;
  fast_hashed_secret_key: string | null;
  project_id: string | null;
  organization_id: string | null;
  scope: string | null;
  expires_at: string | number | null;
}

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

async function findLegacyApiKeyBySecret(
  db: ReturnType<typeof getSharedApiKeyDb>,
  secretKey: string,
): Promise<LegacyApiKeyRow | null> {
  let cursor = "";

  while (true) {
    const rows = db
      .prepare(
        `SELECT id, public_key, hashed_secret_key, fast_hashed_secret_key,
                project_id, organization_id, scope, expires_at
         FROM api_keys
         WHERE fast_hashed_secret_key IS NULL AND id > ?
         ORDER BY id
         LIMIT ?`,
      )
      .all(cursor, LEGACY_KEY_BATCH_SIZE) as LegacyApiKeyRow[];

    for (const row of rows) {
      if (await compare(secretKey, row.hashed_secret_key)) return row;
    }

    if (rows.length < LEGACY_KEY_BATCH_SIZE) return null;
    cursor = rows[rows.length - 1].id;
  }
}

// ---------------------------------------------------------------------------
// Unified auth middleware
// ---------------------------------------------------------------------------

export async function unifiedAuth(c: Context<GatewayEnv>, next: Next): Promise<Response | void> {
  const authHeader = c.req.header("authorization");

  if (!authHeader) {
    return c.json(
      {
        error: {
          message: "Missing Authorization header. Use Bearer <secretKey> or Basic <base64(pk:sk)>.",
          type: "authentication_error",
        },
      },
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
      {
        error: {
          message: "Invalid Authorization header format. Use Bearer <sk> or Basic <base64(pk:sk)>.",
          type: "authentication_error",
        },
      },
      401,
    );
  }

  // Check cache
  const cacheKey = createHash("sha256").update(secretKey).digest("hex");
  const cached = authCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (hintPublicKey && hintPublicKey !== cached.publicKey) {
      return c.json(
        { error: { message: "Invalid credentials", type: "authentication_error" } },
        401,
      );
    }
    c.set("projectId", cached.projectId);
    c.set("orgId", cached.orgId);
    c.set("apiKeyId", cached.publicKey);
    c.set("apiKeyPrefix", cached.publicKey);
    const gwConfig = await getGatewayConfig(cached.publicKey, cached.projectId);
    c.set("apiKeyRecord", gwConfig);
    return next();
  }

  // Verify against shared DB
  const db = getSharedApiKeyDb();
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

    if (!apiKeyRow) {
      return c.json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401);
    }

    const isValid = await compare(secretKey, apiKeyRow.hashed_secret_key);
    if (!isValid) {
      return c.json(
        { error: { message: "Invalid credentials", type: "authentication_error" } },
        401,
      );
    }
    // Backfill fast hash
    if (salt && !apiKeyRow.fast_hashed_secret_key) {
      const shaHash = createShaHash(secretKey, salt);
      try {
        db.prepare(`UPDATE api_keys SET fast_hashed_secret_key = ? WHERE id = ?`).run(
          shaHash,
          apiKeyRow.id,
        );
      } catch {
        /* ignore */
      }
    }
  }

  // Slow path: bcrypt comparison across all keys (fallback)
  if (!apiKeyRow) {
    const isLegacyBearerScan = bearerToken !== null;
    if (isLegacyBearerScan && legacyBearerScanInProgress) {
      c.header("Retry-After", "1");
      return c.json(
        {
          error: {
            message: "Legacy API key verification is busy. Retry shortly.",
            type: "service_unavailable_error",
          },
        },
        503,
      );
    }

    if (isLegacyBearerScan) legacyBearerScanInProgress = true;
    try {
      const legacyRow = await findLegacyApiKeyBySecret(db, secretKey);
      if (legacyRow) {
        // Backfill fast hash for future requests
        if (salt) {
          const shaHash = createShaHash(secretKey, salt);
          try {
            db.prepare(`UPDATE api_keys SET fast_hashed_secret_key = ? WHERE id = ?`).run(
              shaHash,
              legacyRow.id,
            );
          } catch {
            /* ignore */
          }
        }
        apiKeyRow = legacyRow;
      }
    } finally {
      if (isLegacyBearerScan) legacyBearerScanInProgress = false;
    }

    if (!apiKeyRow) {
      return c.json(
        { error: { message: "Invalid secret key", type: "authentication_error" } },
        401,
      );
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
      {
        error: {
          message:
            "Gateway requires a PROJECT-scoped API key. Organization-level keys are not supported.",
          type: "authentication_error",
        },
      },
      403,
    );
  }

  const resolvedPublicKey = apiKeyRow.public_key ?? apiKeyRow.publicKey;

  // Cache the auth result
  if (hintPublicKey && hintPublicKey !== resolvedPublicKey) {
    return c.json({ error: { message: "Invalid credentials", type: "authentication_error" } }, 401);
  }
  authCache.set(cacheKey, {
    publicKey: resolvedPublicKey,
    projectId,
    orgId,
    expiresAt: Math.min(
      Date.now() + AUTH_CACHE_TTL_MS,
      apiKeyRow.expires_at ? new Date(apiKeyRow.expires_at).getTime() : Infinity,
    ),
  });

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
  const config = await db.query.apiKey.findFirst({
    where: and(eq(apiKey.publicKey, publicKey), eq(apiKey.projectId, projectId)),
  });

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
