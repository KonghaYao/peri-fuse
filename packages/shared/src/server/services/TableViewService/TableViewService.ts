import { and, eq, inArray } from "drizzle-orm";
import { v4 } from "uuid";
import { Prisma, prisma, toKnownRequestError } from "../../../db";
import { tableViewPresets as preset } from "../../../db/schema/index.js";
import {
  type TableViewPresetDomain,
  TableViewPresetTableName,
} from "../../../domain/table-view-presets";
import { LangfuseConflictError, LangfuseNotFoundError } from "../../../errors";
import { parseJsonPrioritised } from "../../../utils/json";
import {
  getSystemTableViewPresetById,
  getSystemTableViewPresetByTableAndId,
  getSystemTableViewPresets,
  isSystemTableViewPresetId,
} from "./systemPresets";
import {
  type CreateTableViewPresetsInput,
  type TableViewPresetsNamesCreatorList,
  TableViewPresetsNamesCreatorListSchema,
  type UpdateTableViewPresetsInput,
  type UpdateTableViewPresetsNameInput,
} from "./types";

const TABLE_NAME_TO_URL_MAP: Partial<Record<TableViewPresetTableName, string>> = {
  [TableViewPresetTableName.Traces]: "traces",
  [TableViewPresetTableName.Observations]: "observations",
  [TableViewPresetTableName.ObservationsEvents]: "traces",
  [TableViewPresetTableName.Scores]: "scores",
  [TableViewPresetTableName.Sessions]: "sessions",
  [TableViewPresetTableName.Datasets]: "datasets",
  [TableViewPresetTableName.Experiments]: "experiments",
  [TableViewPresetTableName.ExperimentItems]: "experiments/results",
};

// The v4 table was mistakenly released under the `observations` table name,
// so we need to read legacy presets that belong to the events table under the `observations` name.
// To avoid proliferating this compatibility logic, we only apply it when reading presets for the events table,
// and we never allow it when writing (creating/updating) presets.
const getReadCompatibleTableNames = (
  tableName: TableViewPresetTableName,
): TableViewPresetTableName[] =>
  tableName === TableViewPresetTableName.ObservationsEvents
    ? [TableViewPresetTableName.ObservationsEvents, TableViewPresetTableName.Observations]
    : [tableName];

const TABLE_VIEW_PRESET_NAME_CONFLICT_MESSAGE =
  "Table view preset with this name already exists. Please choose a different name.";

const throwTableViewPresetConflictIfDuplicateName = (error: unknown): never => {
  const knownError = toKnownRequestError(error);
  if (knownError && knownError.code === "P2002") {
    throw new LangfuseConflictError(TABLE_VIEW_PRESET_NAME_CONFLICT_MESSAGE);
  }

  throw error;
};

// JSON columns are stored as TEXT under drizzle/SQLite; serialize on write and
// parse on read so downstream zod schemas receive plain objects/arrays.
const parsePresetJsonColumns = (row: {
  filters: string;
  columnOrder: string;
  columnVisibility: string;
  orderBy: string | null;
}) => ({
  filters: parseJsonPrioritised(row.filters) ?? [],
  columnOrder: parseJsonPrioritised(row.columnOrder) ?? [],
  columnVisibility: parseJsonPrioritised(row.columnVisibility) ?? {},
  orderBy: row.orderBy ? (parseJsonPrioritised(row.orderBy) ?? null) : null,
});

export class TableViewService {
  /**
   * Creates a table view preset
   */
  public static async createTableViewPresets(
    input: CreateTableViewPresetsInput,
    createdBy: string,
  ): Promise<TableViewPresetDomain> {
    const newTableViewPresets = await prisma
      .insert(preset)
      .values({
        id: v4(),
        projectId: input.projectId,
        name: input.name,
        tableName: input.tableName,
        searchQuery: input.searchQuery,
        createdBy,
        updatedBy: createdBy,
        filters: JSON.stringify(input.filters),
        columnOrder: JSON.stringify(input.columnOrder),
        columnVisibility: JSON.stringify(input.columnVisibility),
        orderBy: input.orderBy ? JSON.stringify(input.orderBy) : null,
      })
      .returning()
      .then((rows) => rows[0]);

    return {
      ...newTableViewPresets,
      ...parsePresetJsonColumns(newTableViewPresets),
    } as unknown as TableViewPresetDomain;
  }

  /**
   * Updates a table view preset's definition
   */
  public static async updateTableViewPresets(
    input: UpdateTableViewPresetsInput,
    updatedBy: string,
  ): Promise<TableViewPresetDomain> {
    const foundPreset = await prisma
      .select()
      .from(preset)
      .where(
        and(
          eq(preset.id, input.id),
          eq(preset.projectId, input.projectId),
          inArray(preset.tableName, getReadCompatibleTableNames(input.tableName)),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!foundPreset) {
      throw new LangfuseNotFoundError(
        `Saved table view preset not found for table ${input.tableName} in project ${input.projectId}`,
      );
    }

    try {
      const updatedTableViewPresets = await prisma
        .update(preset)
        .set({
          name: input.name,
          tableName: input.tableName,
          filters: JSON.stringify(input.filters),
          columnOrder: JSON.stringify(input.columnOrder),
          columnVisibility: JSON.stringify(input.columnVisibility),
          searchQuery: input.searchQuery,
          orderBy: input.orderBy ? JSON.stringify(input.orderBy) : null,
          updatedBy,
        })
        .where(
          and(
            eq(preset.id, input.id),
            eq(preset.projectId, input.projectId),
          ),
        )
        .returning()
        .then((rows) => rows[0]);

      return {
        ...updatedTableViewPresets,
        ...parsePresetJsonColumns(updatedTableViewPresets),
      } as unknown as TableViewPresetDomain;
    } catch (error) {
      return throwTableViewPresetConflictIfDuplicateName(error);
    }
  }

  /**
   * Updates a table view preset's name
   */
  public static async updateTableViewPresetsName(
    input: UpdateTableViewPresetsNameInput,
    updatedBy: string,
  ): Promise<TableViewPresetDomain> {
    const foundPreset = await prisma
      .select()
      .from(preset)
      .where(
        and(
          eq(preset.id, input.id),
          eq(preset.projectId, input.projectId),
          inArray(preset.tableName, getReadCompatibleTableNames(input.tableName)),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!foundPreset) {
      throw new LangfuseNotFoundError(
        `Saved table view preset not found for table ${input.tableName} in project ${input.projectId}`,
      );
    }

    try {
      const updatedTableViewPresets = await prisma
        .update(preset)
        .set({
          name: input.name,
          tableName: input.tableName,
          updatedBy,
        })
        .where(
          and(
            eq(preset.id, input.id),
            eq(preset.projectId, input.projectId),
          ),
        )
        .returning()
        .then((rows) => rows[0]);

      return {
        ...updatedTableViewPresets,
        ...parsePresetJsonColumns(updatedTableViewPresets),
      } as unknown as TableViewPresetDomain;
    } catch (error) {
      return throwTableViewPresetConflictIfDuplicateName(error);
    }
  }

  /**
   * Deletes a table view preset
   */
  public static async deleteTableViewPresets(
    TableViewPresetsId: string,
    projectId: string,
  ): Promise<void> {
    await prisma
      .delete(preset)
      .where(
        and(
          eq(preset.id, TableViewPresetsId),
          eq(preset.projectId, projectId),
        ),
      );
  }

  /**
   * Gets all table view presets for a table
   */
  public static async getTableViewPresetsByTableName(
    tableName: TableViewPresetTableName,
    projectId: string,
  ): Promise<TableViewPresetsNamesCreatorList> {
    const rows = await prisma.query.tableViewPresets.findMany({
      where: and(
        inArray(preset.tableName, getReadCompatibleTableNames(tableName)),
        eq(preset.projectId, projectId),
      ),
      with: {
        user_createdBy: true,
      },
    });

    const records = rows.map(({ user_createdBy, ...row }) => ({
      ...row,
      ...parsePresetJsonColumns(row),
      createdByUser: user_createdBy
        ? { image: user_createdBy.image, name: user_createdBy.name }
        : null,
    }));

    const systemPresets = getSystemTableViewPresets(tableName).map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      isSystem: true,
      category: preset.category,
      tableName: preset.tableName,
      createdBy: null,
      createdByUser: null,
      filters: preset.state.filters,
      columnOrder: preset.state.columnOrder,
      columnVisibility: preset.state.columnVisibility,
      searchQuery: preset.state.searchQuery ?? null,
      orderBy: preset.state.orderBy,
    }));

    const presets = TableViewPresetsNamesCreatorListSchema.parse([...systemPresets, ...records]);

    if (tableName === TableViewPresetTableName.ObservationsEvents) {
      // Deduplicate presets that have the same name,
      // preferring presets that belong to the canonical events table namespace
      // over presets that belong to the legacy observations namespace.
      const presetsByName = new Map<string, TableViewPresetsNamesCreatorList[number]>();

      for (const preset of presets) {
        const existingPreset = presetsByName.get(preset.name);

        if (
          !existingPreset ||
          (preset.tableName === TableViewPresetTableName.ObservationsEvents &&
            existingPreset.tableName === TableViewPresetTableName.Observations) ||
          // Non-system presets should take precedence over system presets
          (!preset.isSystem && existingPreset.isSystem)
        ) {
          presetsByName.set(preset.name, {
            ...preset,
            // A user view displacing a same-named system preset inherits its
            // category, so the category chip keeps the entry (now applying
            // the user's customized version) instead of silently dropping it.
            category: preset.category ?? existingPreset?.category,
          });
        }
      }

      return Array.from(presetsByName.values());
    }

    return presets;
  }

  /**
   * Gets a table view preset by id
   */
  public static async getTableViewPresetsById(
    id: string,
    projectId: string,
  ): Promise<TableViewPresetDomain> {
    if (isSystemTableViewPresetId(id)) {
      const systemPreset = getSystemTableViewPresetById(id);

      if (!systemPreset) {
        throw new LangfuseNotFoundError(
          `Saved table view preset not found for id ${id} in project ${projectId}`,
        );
      }

      return {
        id: systemPreset.id,
        projectId,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        createdBy: null,
        name: systemPreset.name,
        tableName: systemPreset.tableName,
        filters: systemPreset.state.filters,
        columnOrder: systemPreset.state.columnOrder,
        columnVisibility: systemPreset.state.columnVisibility,
        searchQuery: systemPreset.state.searchQuery ?? null,
        orderBy: systemPreset.state.orderBy,
      };
    }

    const foundPreset = await prisma
      .select()
      .from(preset)
      .where(
        and(
          eq(preset.id, id),
          eq(preset.projectId, projectId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!foundPreset) {
      throw new LangfuseNotFoundError(
        `Saved table view preset not found for id ${id} in project ${projectId}`,
      );
    }

    return {
      ...foundPreset,
      ...parsePresetJsonColumns(foundPreset),
    } as unknown as TableViewPresetDomain;
  }

  /**
   * Generates a permanent link to a table view preset
   */
  public static async generatePermalink(
    baseUrl: string,
    TableViewPresetsId: string,
    tableName: TableViewPresetTableName,
    projectId: string,
  ): Promise<string> {
    if (
      isSystemTableViewPresetId(TableViewPresetsId) &&
      !getSystemTableViewPresetByTableAndId(tableName, TableViewPresetsId)
    ) {
      throw new Error(`Permalinks are not supported for preset ${TableViewPresetsId}`);
    }

    const page = TABLE_NAME_TO_URL_MAP[tableName];
    if (!page) {
      throw new Error(`Permalinks are not supported for table ${tableName}`);
    }
    return `${baseUrl}/project/${projectId}/${page}?viewId=${TableViewPresetsId}`;
  }
}
