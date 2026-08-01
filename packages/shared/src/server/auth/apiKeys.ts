import * as crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { v4 } from "uuid";
import { compare, hash } from "bcryptjs";
import type { Cluster, Redis } from "ioredis";
import type { Db } from "../../db";
import { apiKeys } from "../../db/schema/index.js";
import { env } from "../../env";
import type { ApiKeyScope } from "../../prisma-enums";
import { invalidateCachedApiKeys } from "./invalidateApiKeys";

export function getDisplaySecretKey(secretKey: string) {
  return `${secretKey.slice(0, 6)}...${secretKey.slice(-4)}`;
}

export async function hashSecretKey(key: string) {
  // legacy, uses bcrypt, transformed into hashed key upon first use
  const hashedKey = await hash(key, 11);
  return hashedKey;
}

export async function generateKeySet() {
  return {
    pk: `pk-lf-${randomUUID()}`,
    sk: `sk-lf-${randomUUID()}`,
  };
}

export async function verifySecretKey(key: string, hashedKey: string) {
  const isValid = await compare(key, hashedKey);
  return isValid;
}

export function createShaHash(privateKey: string, salt: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(privateKey)
    .update(crypto.createHash("sha256").update(salt, "utf8").digest("hex"))
    .digest("hex");

  return hash;
}

export async function createAndAddApiKeysToDb(p: {
  prisma: Db;
  entityId: string;
  scope: ApiKeyScope;
  note?: string;
  isInAppAgentKey?: boolean;
  /** User who created the key, e.g. via the UI. */
  createdByUserId?: string;
  /** API key that created the key, e.g. an org-scoped key using the public API. */
  createdByApiKeyId?: string;
  predefinedKeys?: {
    secretKey: string;
    publicKey: string;
  };
}) {
  const salt = env.SALT;
  if (!salt) {
    throw new Error("SALT is not set");
  }

  const { pk, sk } = p.predefinedKeys
    ? { pk: p.predefinedKeys.publicKey, sk: p.predefinedKeys.secretKey }
    : await generateKeySet();

  const hashedSk = await hashSecretKey(sk);
  const displaySk = getDisplaySecretKey(sk);

  const hashFromProvidedKey = createShaHash(sk, salt);

  const entity =
    p.scope === "PROJECT" ? { projectId: p.entityId } : { organizationId: p.entityId };

  const apiKey = await p.prisma
    .insert(apiKeys)
    .values({
      id: v4(),
      ...entity,
      publicKey: pk,
      hashedSecretKey: hashedSk,
      displaySecretKey: displaySk,
      fastHashedSecretKey: hashFromProvidedKey,
      note: p.note,
      scope: p.scope,
      isInAppAgentKey: p.isInAppAgentKey ?? false,
      createdByUserId: p.createdByUserId,
      createdByApiKeyId: p.createdByApiKeyId,
    })
    .returning()
    .then((rows) => rows[0]);

  return {
    id: apiKey.id,
    createdAt: apiKey.createdAt,
    note: apiKey.note,
    publicKey: apiKey.publicKey,
    secretKey: sk,
    displaySecretKey: displaySk,
  };
}

export async function deleteApiKeyFromDb(p: {
  prisma: Db;
  id: string;
  entityId: string;
  scope: ApiKeyScope;
  redis?: Redis | Cluster | null;
}) {
  const apiKey = await p.prisma
    .select()
    .from(apiKeys)
    .where(
      and(
        p.scope === "PROJECT"
          ? eq(apiKeys.projectId, p.entityId)
          : eq(apiKeys.organizationId, p.entityId),
        eq(apiKeys.id, p.id),
        eq(apiKeys.scope, p.scope),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (!apiKey) {
    throw new Error(`API key ${p.id} not found`);
  }

  await invalidateCachedApiKeys([apiKey], `key ${p.id}`, p.redis);

  await p.prisma.delete(apiKeys).where(eq(apiKeys.id, apiKey.id));

  return true;
}
