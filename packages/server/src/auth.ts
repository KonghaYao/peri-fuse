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

import { CloudConfigRateLimit } from "@langfuse-lite/shared";
import { prisma } from "@langfuse-lite/shared/src/db";
import {
  type ApiAccessScope,
  type AuthHeaderValidVerificationResultIngestion,
  type AuthHeaderVerificationResult,
  createShaHash,
  logger,
  verifySecretKey,
} from "@langfuse-lite/shared/src/server";
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

const apiKeyInclude = {
  project: { include: { organization: true } },
  organization: true,
} as const;

/**
 * Verifies an `Authorization` header against the API keys stored in the
 * lite SQLite database (Prisma). Returns the same shape as web's
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
        ? await prisma.apiKey.findUnique({
            where: { fastHashedSecretKey: createShaHash(secretKey, salt) },
            include: apiKeyInclude,
          })
        : null;

    // Slow path: bcrypt comparison against the legacy hash, then backfill.
    if (!apiKey) {
      const slowKey = await prisma.apiKey.findUnique({
        where: { publicKey },
        include: apiKeyInclude,
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
        await prisma.apiKey
          .update({
            where: { publicKey },
            data: { fastHashedSecretKey: shaKey },
          })
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

    const orgCloudConfig =
      apiKey.project?.organization?.cloudConfig ?? apiKey.organization?.cloudConfig ?? null;

    const parsedRateLimitOverrides = CloudConfigRateLimit.safeParse(
      (orgCloudConfig as { rateLimitOverrides?: unknown } | null)?.rateLimitOverrides,
    );

    return {
      validKey: true,
      scope: {
        projectId: apiKey.projectId,
        accessLevel,
        orgId: apiKey.orgId ?? apiKey.project?.organization?.id ?? "",
        plan: "oss",
        rateLimitOverrides: parsedRateLimitOverrides.success ? parsedRateLimitOverrides.data : [],
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
