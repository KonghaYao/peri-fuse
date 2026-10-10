import { relationalFilter } from "@peri-fuse/shared/src/db/relational-filter";
/**
 * Lite server authentication.
 *
 * Simplified port of web's `ApiAuthService.verifyAuthHeaderAndReturnScope`
 * (web/src/features/public-api/server/apiAuth.ts) without Redis caching,
 * entitlements, rate limiting, or OTel instrumentation.
 *
 * Supports `Authorization: Basic <base64(publicKey:secretKey)>`.
 * Verification strategy (same as web):
 *   1. Fast path: look up the API key by SHA-256 hash of the secret key.
 *   2. Slow path: look up by publicKey and bcrypt-compare the secret key,
 *      then backfill the fast hash.
 */

import { CloudConfigRateLimit, parseJsonPrioritised } from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { apiKeys } from "@peri-fuse/shared/src/db/schema/index.js";
import {
  type ApiAccessScope,
  type AuthHeaderValidVerificationResultIngestion,
  type AuthHeaderVerificationResult,
  createShaHash,
  logger,
  verifySecretKey,
} from "@peri-fuse/shared/src/server";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

export type AuthScope = ApiAccessScope & {
  projectId: string;
};

export type LiteServerEnv = {
  Variables: {
    auth: AuthHeaderValidVerificationResultIngestion & {
      scope: AuthScope;
    };
  };
};

function extractBasicAuthCredentials(basicAuthHeader: string): {
  username: string;
  password: string;
} {
  const authValue = basicAuthHeader.split(" ")[1];
  if (!authValue) throw new Error("Invalid authorization header");

  const [username, password] = atob(authValue).split(":");
  if (!username || !password) throw new Error("Invalid authorization header");
  return { username, password };
}

const apiKeyWith = {
  project: {
    columns: { id: true },
    with: { organization: { columns: { id: true, cloudConfig: true } } },
  },
  organization: { columns: { cloudConfig: true } },
} as const;

const apiKeyColumns = {
  id: true,
  publicKey: true,
  hashedSecretKey: true,
  fastHashedSecretKey: true,
  expiresAt: true,
  scope: true,
  projectId: true,
  organizationId: true,
  isInAppAgentKey: true,
} as const;

// Auth rows are checked on every request so revocation and scope changes stay
// immediate. Only the pure cloud config parse is reused by raw DB value.
type RateLimitOverrides = ReturnType<typeof CloudConfigRateLimit.parse>;
const rateLimitCache = new Map<string, RateLimitOverrides>();
function rateLimitOverrides(raw: string | null): RateLimitOverrides {
  if (!raw) return [];
  const cacheable = raw.length <= 16 * 1024;
  const cached = cacheable ? rateLimitCache.get(raw) : undefined;
  if (cached) return cached.map((entry) => ({ ...entry }));
  const config = parseJsonPrioritised(raw);
  const parsed = CloudConfigRateLimit.safeParse(
    (config as { rateLimitOverrides?: unknown } | null)?.rateLimitOverrides,
  );
  const value = parsed.success ? parsed.data : [];
  if (cacheable) {
    if (rateLimitCache.size >= 64)
      rateLimitCache.delete(rateLimitCache.keys().next().value as string);
    rateLimitCache.set(raw, value);
  }
  return value.map((entry) => ({ ...entry }));
}

/**
 * Verifies an `Authorization` header against the API keys stored in the
 * lite SQLite database (Drizzle). Returns the same shape as web's
 * ApiAuthService so downstream shared ingestion code can consume it as-is.
 */
export async function verifyAuthHeader(
  authHeader: string | undefined,
): Promise<AuthHeaderVerificationResult> {
  if (!authHeader) {
    return { validKey: false, error: "No authorization header" };
  }

  try {
    if (!authHeader.startsWith("Basic ")) {
      return { validKey: false, error: "Invalid authorization header" };
    }

    const { username: publicKey, password: secretKey } = extractBasicAuthCredentials(authHeader);

    // eslint-disable-next-line turbo/no-undeclared-env-vars -- runtime auth salt, not a build input
    const salt = process.env.SALT;

    // Fast path: resolve the key via the SHA-256 hash of the secret key.
    let apiKey =
      salt != null
        ? await prisma.query.apiKeys.findFirst({
            where: relationalFilter(
              eq(apiKeys.fastHashedSecretKey, createShaHash(secretKey, salt)),
            ),
            columns: apiKeyColumns,
            with: apiKeyWith,
          })
        : null;

    // Slow path: bcrypt comparison against the legacy hash, then backfill.
    if (!apiKey) {
      const slowKey = await prisma.query.apiKeys.findFirst({
        where: relationalFilter(eq(apiKeys.publicKey, publicKey)),
        columns: apiKeyColumns,
        with: apiKeyWith,
      });

      if (!slowKey) {
        logger.debug(`[lite-auth] No key found for public key ${publicKey}`);
        throw new Error("Invalid credentials");
      }

      const isValid = await verifySecretKey(secretKey, slowKey.hashedSecretKey);
      if (!isValid) {
        logger.debug(`[lite-auth] Invalid secret key for ${publicKey}`);
        throw new Error("Invalid credentials");
      }

      if (salt != null && !slowKey.fastHashedSecretKey) {
        const shaKey = createShaHash(secretKey, salt);
        await prisma
          .update(apiKeys)
          .set({ fastHashedSecretKey: shaKey })
          .where(eq(apiKeys.publicKey, publicKey))
          .catch((e) => logger.warn(`[lite-auth] Failed to backfill fast hash: ${e}`));
      }

      apiKey = slowKey;
    }

    if (apiKey.publicKey !== publicKey) {
      logger.warn(
        `[lite-auth] Public key mismatch: submitted ${publicKey}, resolved ${apiKey.publicKey}`,
      );
    }

    if (apiKey.expiresAt != null && apiKey.expiresAt.getTime() < Date.now()) {
      throw new Error("API key is expired");
    }

    const accessLevel =
      apiKey.scope === "ORGANIZATION" ? ("organization" as const) : ("project" as const);

    // cloudConfig is stored as a JSON string in SQLite — parse before reading.
    const rawCloudConfig =
      apiKey.project?.organization?.cloudConfig ?? apiKey.organization?.cloudConfig ?? null;

    return {
      validKey: true,
      scope: {
        projectId: apiKey.projectId,
        accessLevel,
        orgId: apiKey.organizationId ?? apiKey.project?.organization?.id ?? "",
        plan: "oss",
        rateLimitOverrides: rateLimitOverrides(rawCloudConfig),
        apiKeyId: apiKey.id,
        publicKey: apiKey.publicKey,
        isIngestionSuspended: false,
        isInAppAgentKey: apiKey.isInAppAgentKey,
      },
    };
  } catch (error: unknown) {
    logger.info(
      `[lite-auth] Error verifying auth header: ${error instanceof Error ? error.message : null}`,
    );
    return {
      validKey: false,
      error:
        (error instanceof Error ? error.message : "Authorization error") +
        ". Confirm that you've configured the correct host.",
    };
  }
}

/**
 * Hono middleware that enforces project-scoped Basic auth and stores the
 * verified scope in the request context under `auth`.
 */
export const authMiddleware = createMiddleware<LiteServerEnv>(async (c, next) => {
  const result = await verifyAuthHeader(c.req.header("authorization"));

  if (result.validKey === false) {
    return c.json({ message: result.error }, 401);
  }

  if (!result.scope.projectId) {
    return c.json(
      {
        message: "Project ID not found for API token. Are you using an organization key?",
      },
      403,
    );
  }

  c.set("auth", {
    validKey: true as const,
    scope: result.scope as AuthScope,
  });

  await next();
});
