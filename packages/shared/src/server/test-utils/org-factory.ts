import { v4 } from "uuid";
import { prisma } from "../../db";
import { apiKeys, organizations, projects } from "../../db/schema/index.js";
import { env } from "../../env";
import { CloudConfigSchema } from "../../interfaces/cloudConfigSchema";
import { createShaHash, getDisplaySecretKey } from "../auth/apiKeys";

export function createBasicAuthHeader(username: string, password: string): string {
  const base64Credentials = Buffer.from(`${username}:${password}`).toString("base64");
  return `Basic ${base64Credentials}`;
}

export type CreateOrgProjectAndApiKeyOptions = {
  projectId?: string;
  plan?: "Team" | "Hobby" | "Core" | "Pro" | "Enterprise";
};

export const createOrgProjectAndApiKey = async (props?: CreateOrgProjectAndApiKeyOptions) => {
  const projectId = props?.projectId ?? v4();
  const org = await prisma
    .insert(organizations)
    .values({
      id: v4(),
      name: v4(),
      cloudConfig: JSON.stringify(
        CloudConfigSchema.parse({
          plan: props?.plan ?? "Team",
        }),
      ),
    })
    .returning()
    .then((rows) => rows[0]);
  const project = await prisma
    .insert(projects)
    .values({
      id: projectId,
      name: v4(),
      orgId: org.id,
    })
    .returning()
    .then((rows) => rows[0]);
  const publicKey = v4();
  const secretKey = `sk-lf-${v4()}`;
  const salt = env.SALT;
  if (!salt) {
    throw new Error("SALT is not set");
  }

  const auth = createBasicAuthHeader(publicKey, secretKey);
  await prisma.insert(apiKeys).values({
    id: v4(),
    projectId: projectId,
    publicKey: publicKey,
    // Test fixtures use the modern fast-hash auth path. Avoid bcrypt here as
    // cost-11 hashing adds ~100ms per fixture; keep the legacy hash unique to
    // satisfy the database constraint without affecting authentication.
    hashedSecretKey: `test-hashed-secret-key-${v4()}`,
    fastHashedSecretKey: createShaHash(secretKey, salt),
    displaySecretKey: getDisplaySecretKey(secretKey),
    scope: "PROJECT",
  });

  return { projectId, orgId: org.id, publicKey, secretKey, auth, org, project };
};
