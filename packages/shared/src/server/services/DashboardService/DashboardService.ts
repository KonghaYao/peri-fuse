import { and, asc, count, desc, eq, isNull, or, type SQL } from "drizzle-orm";
import { v4 } from "uuid";
import type { z } from "zod";
import {
  LangfuseConflictError,
  LangfuseNotFoundError,
  type OrderByState,
  type singleFilter,
} from "../../../";
import { prisma, toKnownRequestError } from "../../../db";
import { dashboards, dashboardWidgets } from "../../../db/schema/index.js";
import { parseJsonPrioritised } from "../../../utils/json";
import {
  type CreateWidgetInput,
  type DashboardDefinitionSchema,
  type DashboardDomain,
  DashboardDomainSchema,
  type DashboardListResponse,
  type WidgetDomain,
  WidgetDomainSchema,
  type WidgetListResponse,
} from "./types";

// JSON columns are stored as TEXT under drizzle/SQLite; parse them back into
// objects/arrays before validating against the domain zod schemas.
const parseDashboardJson = (row: { definition: string; filters: string }) => ({
  definition: parseJsonPrioritised(row.definition) ?? { widgets: [] },
  filters: parseJsonPrioritised(row.filters) ?? [],
});

const parseWidgetJson = (row: {
  dimensions: string;
  metrics: string;
  filters: string;
  chartConfig: string;
}) => ({
  dimensions: parseJsonPrioritised(row.dimensions) ?? [],
  metrics: parseJsonPrioritised(row.metrics) ?? [],
  filters: parseJsonPrioritised(row.filters) ?? [],
  chartConfig: parseJsonPrioritised(row.chartConfig) ?? {},
});

const dashboardOrderBy = (orderBy?: OrderByState) =>
  orderBy
    ? orderBy.order === "ASC"
      ? asc(dashboards[orderBy.column as keyof typeof dashboards] as unknown as SQL)
      : desc(dashboards[orderBy.column as keyof typeof dashboards] as unknown as SQL)
    : desc(dashboards.updatedAt);

const widgetOrderBy = (orderBy?: OrderByState) =>
  orderBy
    ? orderBy.order === "ASC"
      ? asc(dashboardWidgets[orderBy.column as keyof typeof dashboardWidgets] as unknown as SQL)
      : desc(dashboardWidgets[orderBy.column as keyof typeof dashboardWidgets] as unknown as SQL)
    : desc(dashboardWidgets.updatedAt);

export class DashboardService {
  /**
   * Retrieves a list of dashboards for a given project.
   */
  public static async listDashboards(props: {
    projectId: string;
    limit?: number;
    page?: number;
    orderBy?: OrderByState;
    /** Include Langfuse-managed dashboards (projectId null). Defaults to true. */
    includeLangfuseOwned?: boolean;
  }): Promise<DashboardListResponse> {
    const { projectId, limit, page, orderBy, includeLangfuseOwned = true } = props;

    const skip = page && limit ? (page - 1) * limit : undefined;
    const take = limit;

    const where: SQL = includeLangfuseOwned
      ? or(eq(dashboards.projectId, projectId), isNull(dashboards.projectId))
      : eq(dashboards.projectId, projectId);

    const [dashboardRows, totalCountRows] = await Promise.all([
      prisma
        .select()
        .from(dashboards)
        .where(where)
        .orderBy(dashboardOrderBy(orderBy))
        .limit(take ?? -1)
        .offset(skip ?? 0),
      prisma.select({ value: count() }).from(dashboards).where(where),
    ]);
    const totalCount = totalCountRows[0]?.value ?? 0;

    const domainDashboards = dashboardRows.map((dashboard) =>
      DashboardDomainSchema.parse({
        ...dashboard,
        ...parseDashboardJson(dashboard),
        owner: dashboard.projectId ? "PROJECT" : "LANGFUSE",
      }),
    );

    return {
      dashboards: domainDashboards,
      totalCount,
    };
  }

  /**
   * Creates a new dashboard.
   */
  public static async createDashboard(
    projectId: string,
    name: string,
    description: string,
    userId?: string,
    initialDefinition: z.infer<typeof DashboardDefinitionSchema> = {
      widgets: [],
    },
    filters?: z.infer<typeof singleFilter>[],
  ): Promise<DashboardDomain> {
    const newDashboard = await prisma
      .insert(dashboards)
      .values({
        id: v4(),
        name,
        description,
        projectId,
        createdBy: userId,
        updatedBy: userId,
        definition: JSON.stringify(initialDefinition),
        ...(filters !== undefined && { filters: JSON.stringify(filters) }),
      })
      .returning()
      .then((rows) => rows[0]);

    return DashboardDomainSchema.parse({
      ...newDashboard,
      ...parseDashboardJson(newDashboard),
      owner: newDashboard.projectId ? "PROJECT" : "LANGFUSE",
    });
  }

  /**
   * Updates a project-owned dashboard, translating Prisma's P2025 into a 404.
   */
  private static async updateDashboardRecord(
    dashboardId: string,
    projectId: string,
    data: Partial<typeof dashboards.$inferInsert>,
  ): Promise<DashboardDomain> {
    const updatedDashboard = await prisma
      .update(dashboards)
      .set(data)
      .where(and(eq(dashboards.id, dashboardId), eq(dashboards.projectId, projectId)))
      .returning()
      .then((rows) => rows[0]);

    if (!updatedDashboard) {
      // No matching row; also covers cross-project ids, so the 404 does not
      // leak whether the dashboard exists in another project.
      throw new LangfuseNotFoundError(
        `Dashboard ${dashboardId} not found in project ${projectId}`,
      );
    }

    return DashboardDomainSchema.parse({
      ...updatedDashboard,
      ...parseDashboardJson(updatedDashboard),
      owner: updatedDashboard.projectId ? "PROJECT" : "LANGFUSE",
    });
  }

  /**
   * Updates a dashboard's definition.
   */
  public static async updateDashboardDefinition(
    dashboardId: string,
    projectId: string,
    definition: z.infer<typeof DashboardDefinitionSchema>,
    userId?: string,
  ): Promise<DashboardDomain> {
    return DashboardService.updateDashboardRecord(dashboardId, projectId, {
      updatedBy: userId,
      definition: JSON.stringify({
        // Already sanitized: the input is parsed against
        // DashboardDefinitionSchema, which strips unknown keys.
        widgets: definition.widgets,
      }),
    });
  }

  /**
   * Updates a dashboard's name and description.
   */
  public static async updateDashboard(
    dashboardId: string,
    projectId: string,
    name: string,
    description: string,
    userId?: string,
  ): Promise<DashboardDomain> {
    return DashboardService.updateDashboardRecord(dashboardId, projectId, {
      name,
      description,
      updatedBy: userId,
    });
  }

  /**
   * Updates a dashboard's filters.
   */
  public static async updateDashboardFilters(
    dashboardId: string,
    projectId: string,
    filters: z.infer<typeof singleFilter>[],
    userId?: string,
  ): Promise<DashboardDomain> {
    return DashboardService.updateDashboardRecord(dashboardId, projectId, {
      updatedBy: userId,
      filters: JSON.stringify(filters),
    });
  }

  /**
   * Gets a dashboard by ID.
   */
  public static async getDashboard(
    dashboardId: string,
    projectId: string,
  ): Promise<DashboardDomain | null> {
    const dashboard = await prisma
      .select()
      .from(dashboards)
      .where(
        and(
          eq(dashboards.id, dashboardId),
          or(eq(dashboards.projectId, projectId), isNull(dashboards.projectId)),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!dashboard) {
      return null;
    }

    return DashboardDomainSchema.parse({
      ...dashboard,
      ...parseDashboardJson(dashboard),
      owner: dashboard.projectId ? "PROJECT" : "LANGFUSE",
    });
  }

  /**
   * Deletes a dashboard.
   */
  public static async deleteDashboard(dashboardId: string, projectId: string): Promise<void> {
    const deleted = await prisma
      .delete(dashboards)
      .where(and(eq(dashboards.id, dashboardId), eq(dashboards.projectId, projectId)))
      .returning()
      .then((rows) => rows[0]);

    if (!deleted) {
      // No matching row; also covers cross-project ids, so the 404 does not
      // leak whether the dashboard exists in another project.
      throw new LangfuseNotFoundError(
        `Dashboard ${dashboardId} not found in project ${projectId}`,
      );
    }
  }

  /**
   * Retrieves a list of dashboard widgets for a given project.
   */
  public static async listWidgets(props: {
    projectId: string;
    limit?: number;
    page?: number;
    orderBy?: OrderByState;
  }): Promise<WidgetListResponse> {
    const { projectId, limit, page, orderBy } = props;

    const skip = page && limit ? (page - 1) * limit : undefined;
    const take = limit;

    const [widgetRows, totalCountRows] = await Promise.all([
      prisma
        .select()
        .from(dashboardWidgets)
        .where(eq(dashboardWidgets.projectId, projectId))
        .orderBy(widgetOrderBy(orderBy))
        .limit(take ?? -1)
        .offset(skip ?? 0),
      prisma
        .select({ value: count() })
        .from(dashboardWidgets)
        .where(eq(dashboardWidgets.projectId, projectId)),
    ]);
    const totalCount = totalCountRows[0]?.value ?? 0;

    const domainWidgets = widgetRows.map((widget) =>
      WidgetDomainSchema.parse({
        ...widget,
        ...parseWidgetJson(widget),
        owner: widget.projectId ? "PROJECT" : "LANGFUSE",
      }),
    );

    return {
      widgets: domainWidgets,
      totalCount,
    };
  }

  /**
   * Creates a new dashboard widget.
   */
  public static async createWidget(
    projectId: string,
    input: CreateWidgetInput,
    userId?: string,
  ): Promise<WidgetDomain> {
    const newWidget = await prisma
      .insert(dashboardWidgets)
      .values({
        id: v4(),
        name: input.name,
        description: input.description,
        projectId,
        view: input.view,
        dimensions: JSON.stringify(input.dimensions),
        metrics: JSON.stringify(input.metrics),
        filters: JSON.stringify(input.filters),
        chartType: input.chartType,
        chartConfig: JSON.stringify(input.chartConfig),
        minVersion: input.minVersion ?? 1,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning()
      .then((rows) => rows[0]);

    return WidgetDomainSchema.parse({
      ...newWidget,
      ...parseWidgetJson(newWidget),
      owner: newWidget.projectId ? "PROJECT" : "LANGFUSE",
    });
  }

  /**
   * Gets a dashboard widget by ID. Look either in the current project or in the Langfuse managed widgets.
   */
  public static async getWidget(widgetId: string, projectId: string): Promise<WidgetDomain | null> {
    const widget = await prisma
      .select()
      .from(dashboardWidgets)
      .where(
        and(
          eq(dashboardWidgets.id, widgetId),
          or(eq(dashboardWidgets.projectId, projectId), isNull(dashboardWidgets.projectId)),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!widget) {
      return null;
    }

    return WidgetDomainSchema.parse({
      ...widget,
      ...parseWidgetJson(widget),
      owner: widget.projectId ? "PROJECT" : "LANGFUSE",
    });
  }

  /**
   * Updates an existing dashboard widget.
   */
  public static async updateWidget(
    projectId: string,
    widgetId: string,
    input: CreateWidgetInput,
    userId?: string,
  ): Promise<WidgetDomain> {
    const updatedWidget = await prisma
      .update(dashboardWidgets)
      .set({
        name: input.name,
        description: input.description,
        view: input.view,
        dimensions: JSON.stringify(input.dimensions),
        metrics: JSON.stringify(input.metrics),
        filters: JSON.stringify(input.filters),
        chartType: input.chartType,
        chartConfig: JSON.stringify(input.chartConfig),
        ...(input.minVersion !== undefined ? { minVersion: input.minVersion } : {}),
        updatedBy: userId,
      })
      .where(and(eq(dashboardWidgets.id, widgetId), eq(dashboardWidgets.projectId, projectId)))
      .returning()
      .then((rows) => rows[0]);

    return WidgetDomainSchema.parse({
      ...updatedWidget,
      ...parseWidgetJson(updatedWidget),
      owner: updatedWidget.projectId ? "PROJECT" : "LANGFUSE",
    });
  }

  /**
   * Deletes a dashboard widget.
   * Throws an error if the widget is still referenced in any dashboard.
   */
  public static async deleteWidget(widgetId: string, projectId: string): Promise<void> {
    // First check if this widget is referenced in any dashboard definitions.
    // The definition is stored as a JSON string, so parse and filter in memory.
    const projectDashboards = await prisma
      .select({ id: dashboards.id, name: dashboards.name, definition: dashboards.definition })
      .from(dashboards)
      .where(eq(dashboards.projectId, projectId));

    const referencingDashboards = projectDashboards.filter((d) => {
      const definition = parseJsonPrioritised(d.definition) as {
        widgets?: { widgetId?: string }[];
      } | null;
      return (definition?.widgets ?? []).some((w) => w.widgetId === widgetId);
    });

    if (referencingDashboards.length > 0) {
      const dashboardNames = referencingDashboards.map((d) => `"${d.name}"`).join(", ");

      throw new LangfuseConflictError(
        `Cannot delete widget because it is still used in the following dashboards: ${dashboardNames}. Please remove the widget from these dashboards first.`,
      );
    }

    // Delete the widget if it's not referenced
    await prisma
      .delete(dashboardWidgets)
      .where(and(eq(dashboardWidgets.id, widgetId), eq(dashboardWidgets.projectId, projectId)));
  }

  /**
   * Copies a Langfuse-owned widget into the user project, rewires the specified dashboard placement to the new widget and returns the new widget id.
   */
  public static async copyWidgetToProject(props: {
    sourceWidgetId: string;
    projectId: string;
    dashboardId: string;
    placementId: string;
    userId?: string;
  }): Promise<string> {
    const { sourceWidgetId, projectId, dashboardId, placementId, userId } = props;

    const sourceWidget = await prisma
      .select()
      .from(dashboardWidgets)
      .where(and(eq(dashboardWidgets.id, sourceWidgetId), isNull(dashboardWidgets.projectId)))
      .limit(1)
      .then((rows) => rows[0]);

    if (!sourceWidget) {
      throw new LangfuseNotFoundError(`Source widget ${sourceWidgetId} not found`);
    }

    // Duplicate widget and update dashboard definition atomically
    return prisma.transaction(async (tx) => {
      // 1. create duplicate in project scope (JSON columns are already stored
      //    as strings, so they can be copied verbatim)
      const newWidget = await tx
        .insert(dashboardWidgets)
        .values({
          id: v4(),
          name: sourceWidget.name,
          description: sourceWidget.description,
          view: sourceWidget.view,
          dimensions: sourceWidget.dimensions,
          metrics: sourceWidget.metrics,
          filters: sourceWidget.filters,
          chartType: sourceWidget.chartType,
          chartConfig: sourceWidget.chartConfig,
          minVersion: sourceWidget.minVersion,
          projectId, // project owned
          createdBy: userId,
          updatedBy: userId,
        })
        .returning()
        .then((rows) => rows[0]);

      // 2. fetch dashboard to change reference
      const dashboard = await tx
        .select()
        .from(dashboards)
        .where(and(eq(dashboards.id, dashboardId), eq(dashboards.projectId, projectId)))
        .limit(1)
        .then((rows) => rows[0]);

      if (!dashboard) {
        throw new LangfuseNotFoundError(
          `Dashboard ${dashboardId} not found in project ${projectId}`,
        );
      }

      const definition = (parseJsonPrioritised(dashboard.definition) ?? {
        widgets: [],
      }) as unknown as z.infer<typeof DashboardDefinitionSchema>;
      const updatedWidgets = (definition.widgets || []).map((w: any) =>
        w.id === placementId ? { ...w, widgetId: newWidget.id } : w,
      );

      // 3. update dashboard with new widget reference
      await tx
        .update(dashboards)
        .set({
          updatedBy: userId,
          definition: JSON.stringify({ widgets: updatedWidgets }),
        })
        .where(and(eq(dashboards.id, dashboardId), eq(dashboards.projectId, projectId)));

      return newWidget.id;
    });
  }
}
