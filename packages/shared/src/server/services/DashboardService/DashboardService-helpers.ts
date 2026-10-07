import { asc, desc, type SQL } from "drizzle-orm";
import type { OrderByState } from "../../../";
import { dashboards, dashboardWidgets } from "../../../db/schema/index.js";
import { parseJsonPrioritised } from "../../../utils/json";

// JSON columns are stored as TEXT under drizzle/SQLite; parse them back into
// objects/arrays before validating against the domain zod schemas.
export const parseDashboardJson = (row: { definition: string; filters: string }) => ({
  definition: parseJsonPrioritised(row.definition) ?? { widgets: [] },
  filters: parseJsonPrioritised(row.filters) ?? [],
});

export const parseWidgetJson = (row: {
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

export const dashboardOrderBy = (orderBy?: OrderByState) =>
  orderBy
    ? orderBy.order === "ASC"
      ? asc(dashboards[orderBy.column as keyof typeof dashboards] as unknown as SQL)
      : desc(dashboards[orderBy.column as keyof typeof dashboards] as unknown as SQL)
    : desc(dashboards.updatedAt);

export const widgetOrderBy = (orderBy?: OrderByState) =>
  orderBy
    ? orderBy.order === "ASC"
      ? asc(dashboardWidgets[orderBy.column as keyof typeof dashboardWidgets] as unknown as SQL)
      : desc(dashboardWidgets[orderBy.column as keyof typeof dashboardWidgets] as unknown as SQL)
    : desc(dashboardWidgets.updatedAt);
