/**
 * Bootstrap: ensure at least one organization, project, and API key exist.
 *
 * On first boot (empty database), this creates a default org + project + key
 * pair and prints the credentials to the console so the user can start
 * ingesting data immediately.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@peri-fuse/shared/src/db";
import { logger } from "@peri-fuse/shared/src/server";
import { createAndAddApiKeysToDb } from "@peri-fuse/shared/src/server/auth/apiKeys";

export async function ensureBootstrap(): Promise<void> {
  const existingKey = await prisma.apiKey.findFirst();
  if (existingKey) {
    // Already bootstrapped
    return;
  }

  logger.info("[bootstrap] No API keys found — creating default organization and project…");

  const orgId = randomUUID();
  const projectId = randomUUID();

  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Default Org",
    },
  });

  await prisma.project.create({
    data: {
      id: projectId,
      name: "Default Project",
      orgId,
    },
  });

  const keys = await createAndAddApiKeysToDb({
    prisma,
    entityId: projectId,
    scope: "PROJECT",
    note: "Auto-generated on first boot",
  });

  // Print credentials prominently
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║         Peri-Fuse — First Boot Credentials             ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Public Key:  ${keys.publicKey.padEnd(42)}║`);
  console.log(`║  Secret Key:  ${keys.secretKey.padEnd(42)}║`);
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log("║  Save these keys! The secret key cannot be shown again. ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
}
