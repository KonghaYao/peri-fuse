import { and, eq } from "drizzle-orm";
import { v4 } from "uuid";
import type z from "zod";
import { prisma } from "../../db";
import { datasetRuns } from "../../db/schema/index.js";
import type { jsonSchema } from "../../utils/zod";

type Json = z.infer<typeof jsonSchema>;

const isUniqueConstraintError = (error: any): boolean => {
  return (
    error.code === "P2002" || // Prisma-style unique constraint (compat)
    error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    error.message?.includes("duplicate key") ||
    error.message?.toLowerCase().includes("unique constraint") ||
    error.message?.includes("violates unique constraint")
  );
};

const runUniqueWhere = (datasetId: string, projectId: string, name: string) =>
  and(
    eq(datasetRuns.datasetId, datasetId),
    eq(datasetRuns.projectId, projectId),
    eq(datasetRuns.name, name),
  );

/**
 * Create or fetch a dataset run with optimistic concurrency handling.
 *
 * Behavior:
 * - First tries to find an existing run by (projectId, datasetId, name).
 * - If not found, attempts to create it.
 * - If creation fails due to a unique constraint (likely created concurrently),
 *   fetches and returns the existing run.
 * - If all steps fail, throws an error.
 *
 * Rationale: The public API can receive many POST requests almost simultaneously,
 * which is not concurrency-safe without this guard.
 */
export const createOrFetchDatasetRun = async ({
  projectId,
  datasetId,
  name,
  description,
  metadata,
  createdAt,
}: {
  projectId: string;
  datasetId: string;
  name: string;
  description?: string;
  metadata?: Json | null;
  createdAt?: Date;
}) => {
  try {
    // Attempt to fetch existing run
    const existingRun = await prisma
      .select()
      .from(datasetRuns)
      .where(runUniqueWhere(datasetId, projectId, name))
      .limit(1)
      .then((rows) => rows[0]);
    if (existingRun) {
      return existingRun;
    }

    // Attempt creation
    const ts = createdAt ?? new Date();
    const datasetRun = await prisma
      .insert(datasetRuns)
      .values({
        id: v4(),
        datasetId,
        projectId,
        name,
        description: description ?? null,
        // The metadata column is TEXT; better-sqlite3 would treat a raw object
        // as named bind parameters and fail with "Too few parameter values".
        metadata: metadata === undefined || metadata === null ? null : JSON.stringify(metadata),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .then((rows) => rows[0]);
    return datasetRun;
  } catch (error) {
    // Check if it's a unique constraint violation
    if (isUniqueConstraintError(error)) {
      // Fetch existing run
      const existingRun = await prisma
        .select()
        .from(datasetRuns)
        .where(runUniqueWhere(datasetId, projectId, name))
        .limit(1)
        .then((rows) => rows[0]);

      if (existingRun) {
        return existingRun;
      }
    } else {
      throw error;
    }
  }

  throw new Error("Failed to create or fetch dataset run");
};
