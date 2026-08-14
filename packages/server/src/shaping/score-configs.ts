/**
 * Score configs DB → public API shaping.
 *
 * Converts `score_configs` rows (metadata DB) into the public API response
 * shape (phase-1-api-compat.md §4.1): ISO timestamps, parsed `categories`
 * JSON text, and omitted optional fields. The `categories` column is a JSON
 * text blob in SQLite, unlike upstream's ClickHouse array column.
 */

import type { ScoreConfig as ScoreConfigDbType } from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { scoreConfigs } from "@peri-fuse/shared/src/db/schema/index.js";
import { asc, count, desc, eq } from "drizzle-orm";

export type ScoreConfigApi = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL" | "TEXT";
  isArchived: boolean;
  minValue?: number;
  maxValue?: number;
  categories?: Array<{ value: number; label: string }>;
  description?: string;
};

export const dbScoreConfigToApi = (config: ScoreConfigDbType): ScoreConfigApi => {
  let categories: ScoreConfigApi["categories"];
  if (config.categories) {
    try {
      const parsed: unknown = JSON.parse(config.categories);
      if (Array.isArray(parsed)) {
        categories = parsed as ScoreConfigApi["categories"];
      }
    } catch {
      // Malformed JSON in the categories column: treat as absent.
    }
  }

  return {
    id: config.id,
    name: config.name,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
    projectId: config.projectId,
    dataType: config.dataType as ScoreConfigApi["dataType"],
    isArchived: config.isArchived,
    ...(config.minValue != null && { minValue: config.minValue }),
    ...(config.maxValue != null && { maxValue: config.maxValue }),
    ...(categories !== undefined && { categories }),
    ...(config.description != null && { description: config.description }),
  };
};

export const listScoreConfigsForPublicApi = async ({
  projectId,
  page,
  limit,
}: {
  projectId: string;
  page: number;
  limit: number;
}): Promise<{
  data: ScoreConfigApi[];
  meta: { page: number; limit: number; totalItems: number; totalPages: number };
}> => {
  const [rawConfigs, totalItems] = await Promise.all([
    prisma
      .select()
      .from(scoreConfigs)
      .where(eq(scoreConfigs.projectId, projectId))
      .orderBy(desc(scoreConfigs.createdAt), asc(scoreConfigs.id))
      .limit(limit)
      .offset((page - 1) * limit),
    prisma
      .select({ value: count() })
      .from(scoreConfigs)
      .where(eq(scoreConfigs.projectId, projectId))
      .then((rows) => rows[0]?.value ?? 0),
  ]);

  return {
    data: rawConfigs.map(dbScoreConfigToApi),
    meta: {
      page,
      limit,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
    },
  };
};
