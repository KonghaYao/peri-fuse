import { eq } from "drizzle-orm";
import { prisma } from "../db";
import { projects } from "../db/schema/index.js";
import { env } from "../env";
import { logger } from "./logger";

export async function shouldSkipDeletionFor(
  projectId: string,
  entityIds: string[],
  entityType: string,
): Promise<boolean> {
  // Check if project is in skip list
  if (env.LANGFUSE_DELETE_SKIP_PROJECT_IDS.includes(projectId)) {
    logger.info(
      `Skipping ${entityType} deletion for project ${projectId} (in skip list). No deletion processing will occur.`,
      {
        projectId,
        entityType,
        entityIds,
        entityCount: entityIds.length,
        skipReason: "LANGFUSE_DELETE_SKIP_PROJECT_IDS",
      },
    );

    return true;
  }

  // Check if project still exists (might have been deleted)
  const project = await prisma
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!project) {
    logger.info(
      `Skipping ${entityType} deletion for project ${projectId} (project no longer exists). No deletion processing will occur.`,
      {
        projectId,
        entityType,
        entityIds,
        entityCount: entityIds.length,
        skipReason: "PROJECT_NOT_FOUND",
      },
    );

    return true;
  }

  return false;
}
