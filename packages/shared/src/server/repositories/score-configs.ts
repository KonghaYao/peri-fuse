import { and, asc, count, desc, eq } from "drizzle-orm";
import { prisma } from "../../db";
import { scoreConfigs } from "../../db/schema/index.js";
import { InternalServerError, LangfuseNotFoundError } from "../../errors";
import {
  filterAndValidateDbScoreConfigList,
  validateDbScoreConfigSafe,
} from "../../features/scoreConfigs/validation";
import { traceException } from "../instrumentation";

export const listScoreConfigs = async ({
  projectId,
  page,
  limit,
}: {
  projectId: string;
  page: number;
  limit: number;
}) => {
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

  const configs = filterAndValidateDbScoreConfigList(rawConfigs, traceException);

  return {
    data: configs,
    meta: {
      page,
      limit,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
    },
  };
};

export const getScoreConfig = async ({
  projectId,
  configId,
}: {
  projectId: string;
  configId: string;
}) => {
  const config = await prisma
    .select()
    .from(scoreConfigs)
    .where(and(eq(scoreConfigs.id, configId), eq(scoreConfigs.projectId, projectId)))
    .limit(1)
    .then((rows) => rows[0]);

  if (!config) {
    throw new LangfuseNotFoundError("Score config not found within authorized project");
  }

  const parsedConfig = validateDbScoreConfigSafe(config);
  if (!parsedConfig.success) {
    traceException(parsedConfig.error);
    throw new InternalServerError("Requested score config is corrupted");
  }

  return parsedConfig.data;
};
