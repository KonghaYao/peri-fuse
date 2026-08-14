/**
 * Test helper: create a second project + project-scoped API key directly in
 * the metadata DB (same seeding pattern as global-setup.ts) so integration
 * tests can assert project isolation across the public API.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@peri-fuse/shared/src/db";
import { apiKeys, projects } from "@peri-fuse/shared/src/db/schema/index.js";
import { createShaHash, hashSecretKey } from "@peri-fuse/shared/src/server";
import { basicAuth } from "./helpers";
import { TEST_ORG_ID, TEST_SALT } from "./test-db-paths";

export interface SecondProject {
  projectId: string;
  auth: string;
}

export async function createSecondProject(): Promise<SecondProject> {
  const projectId = `test-project-2-${randomUUID()}`;
  const publicKey = `pk-${randomUUID()}`;
  const secretKey = `sk-${randomUUID()}-secret`;

  await prisma.insert(projects).values({
    id: projectId,
    orgId: TEST_ORG_ID,
    name: "Lite Server Test Project 2",
  });
  await prisma.insert(apiKeys).values({
    id: randomUUID(),
    publicKey,
    hashedSecretKey: await hashSecretKey(secretKey),
    fastHashedSecretKey: createShaHash(secretKey, TEST_SALT),
    displaySecretKey: `${secretKey.slice(0, 10)}...`,
    projectId,
    organizationId: TEST_ORG_ID,
    scope: "PROJECT",
  });

  return { projectId, auth: basicAuth(publicKey, secretKey) };
}
