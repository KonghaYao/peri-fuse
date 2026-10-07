import { and, eq, inArray } from "drizzle-orm";
import { prisma } from "../../db";
import { prompts as promptsTable } from "../../db/schema/index.js";
import type { ObservationType } from "../../domain";
import { observationsTableCols } from "../../observationsTable";
import type { FilterState } from "../../types";
import { FilterList, StringFilter } from "../queries";
import { createFilterFromFilterState } from "../queries/clickhouse-sql/factory";
import { observationsTableUiColumnDefinitions } from "../tableMappings";
import { queryClickhouse } from "./clickhouse";

export const getObservationsGroupedByModel = async (projectId: string, filter: FilterState) => {
  const observationsFilter = new FilterList([
    new StringFilter({
      clickhouseTable: "observations",
      field: "project_id",
      operator: "=",
      value: projectId,
      tablePrefix: "o",
    }),
  ]);

  observationsFilter.push(
    ...createFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitions,
      observationsTableCols,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  // We mainly use queries like this to retrieve filter options.
  // Therefore, we can skip final as some inaccuracy in count is acceptable.
  const query = `
    SELECT o.provided_model_name as name
    FROM observations o
    WHERE ${appliedObservationsFilter.query}
    AND o.type = 'GENERATION'
    GROUP BY o.provided_model_name
    ORDER BY count() DESC
    LIMIT 1000;
  `;

  const res = await queryClickhouse<{ name: string }>({
    query,
    params: {
      ...appliedObservationsFilter.params,
    },
    tags: { projectId },
    preferredClickhouseService: "ReadOnly",
  });
  return res.map((r) => ({ model: r.name }));
};

export const getObservationsGroupedByModelId = async (projectId: string, filter: FilterState) => {
  const observationsFilter = new FilterList([
    new StringFilter({
      clickhouseTable: "observations",
      field: "project_id",
      operator: "=",
      value: projectId,
      tablePrefix: "o",
    }),
  ]);

  observationsFilter.push(
    ...createFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitions,
      observationsTableCols,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  // We mainly use queries like this to retrieve filter options.
  // Therefore, we can skip final as some inaccuracy in count is acceptable.
  const query = `
    SELECT o.internal_model_id as modelId
    FROM observations o
    WHERE ${appliedObservationsFilter.query}
    AND o.type = 'GENERATION'
    GROUP BY o.internal_model_id
    ORDER BY count() DESC
    LIMIT 1000;
  `;

  const res = await queryClickhouse<{ modelId: string }>({
    query,
    params: {
      ...appliedObservationsFilter.params,
    },
    tags: { projectId },
    preferredClickhouseService: "ReadOnly",
  });
  return res.map((r) => ({ modelId: r.modelId }));
};

export const getObservationsGroupedByName = async (
  projectId: string,
  filter: FilterState,
  type: ObservationType | null = "GENERATION",
) => {
  const observationsFilter = new FilterList([
    new StringFilter({
      clickhouseTable: "observations",
      field: "project_id",
      operator: "=",
      value: projectId,
      tablePrefix: "o",
    }),
  ]);

  observationsFilter.push(
    ...createFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitions,
      observationsTableCols,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  // We mainly use queries like this to retrieve filter options.
  // Therefore, we can skip final as some inaccuracy in count is acceptable.
  const query = `
    SELECT o.name as name
    FROM observations o
    WHERE ${appliedObservationsFilter.query}
    ${type ? `AND o.type = {type: String}` : ""}
    GROUP BY o.name
    ORDER BY count() DESC
    LIMIT 1000;
  `;

  const res = await queryClickhouse<{ name: string }>({
    query,
    params: {
      ...appliedObservationsFilter.params,
      ...(type ? { type } : {}),
    },
    tags: { projectId },
    preferredClickhouseService: "ReadOnly",
  });
  return res;
};

export const getObservationsGroupedByToolName = async (projectId: string, filter: FilterState) => {
  const observationsFilter = new FilterList([
    new StringFilter({
      clickhouseTable: "observations",
      field: "project_id",
      operator: "=",
      value: projectId,
      tablePrefix: "o",
    }),
  ]);

  observationsFilter.push(
    ...createFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitions,
      observationsTableCols,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  const query = `
    SELECT arrayJoin(mapKeys(o.tool_definitions)) as toolName
    FROM observations o
    WHERE ${appliedObservationsFilter.query}
    AND length(mapKeys(o.tool_definitions)) > 0
    GROUP BY toolName
    ORDER BY count() DESC
    LIMIT 1000;
  `;

  const res = await queryClickhouse<{ toolName: string }>({
    query,
    params: {
      ...appliedObservationsFilter.params,
    },
    tags: { projectId },
    preferredClickhouseService: "ReadOnly",
  });
  return res;
};

export const getObservationsGroupedByCalledToolName = async (
  projectId: string,
  filter: FilterState,
) => {
  const observationsFilter = new FilterList([
    new StringFilter({
      clickhouseTable: "observations",
      field: "project_id",
      operator: "=",
      value: projectId,
      tablePrefix: "o",
    }),
  ]);

  observationsFilter.push(
    ...createFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitions,
      observationsTableCols,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  const query = `
    SELECT arrayJoin(o.tool_call_names) as calledToolName
    FROM observations o
    WHERE ${appliedObservationsFilter.query}
    AND length(o.tool_call_names) > 0
    GROUP BY calledToolName
    ORDER BY count() DESC
    LIMIT 1000;
  `;

  const res = await queryClickhouse<{ calledToolName: string }>({
    query,
    params: {
      ...appliedObservationsFilter.params,
    },
    tags: { projectId },
    preferredClickhouseService: "ReadOnly",
  });
  return res;
};

export const getObservationsGroupedByPromptName = async (
  projectId: string,
  filter: FilterState,
) => {
  const observationsFilter = new FilterList([
    new StringFilter({
      clickhouseTable: "observations",
      field: "project_id",
      operator: "=",
      value: projectId,
      tablePrefix: "o",
    }),
  ]);

  observationsFilter.push(
    ...createFilterFromFilterState(
      filter,
      observationsTableUiColumnDefinitions,
      observationsTableCols,
    ),
  );

  const appliedObservationsFilter = observationsFilter.apply();

  // We mainly use queries like this to retrieve filter options.
  // Therefore, we can skip final as some inaccuracy in count is acceptable.
  const query = `
    SELECT o.prompt_id as id
    FROM observations o
    WHERE ${appliedObservationsFilter.query}
    AND o.type = 'GENERATION'
    AND o.prompt_id IS NOT NULL
    GROUP BY o.prompt_id
    ORDER BY count() DESC
    LIMIT 1000;
    `;

  const res = await queryClickhouse<{ id: string }>({
    query,
    params: {
      ...appliedObservationsFilter.params,
    },
    tags: { projectId },
    preferredClickhouseService: "ReadOnly",
  });

  const prompts = res.map((r) => r.id).filter((r): r is string => Boolean(r));

  const pgPrompts =
    prompts.length > 0
      ? await prisma
          .select({
            id: promptsTable.id,
            name: promptsTable.name,
          })
          .from(promptsTable)
          .where(and(inArray(promptsTable.id, prompts), eq(promptsTable.projectId, projectId)))
      : [];

  return pgPrompts.map((p) => ({
    promptName: p.name,
  }));
};
