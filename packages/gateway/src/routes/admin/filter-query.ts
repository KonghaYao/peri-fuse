import { and, eq, gte, lte, type SQL } from "drizzle-orm";
import { dailySpend } from "../../db/schema.js";

export function usageConditions(projectId: string, raw: Record<string, string>): SQL {
  const conditions: SQL[] = [eq(dailySpend.projectId, projectId)];
  if (raw.startDate) conditions.push(gte(dailySpend.date, raw.startDate));
  if (raw.endDate) conditions.push(lte(dailySpend.date, raw.endDate));
  if (raw.apiKey) conditions.push(eq(dailySpend.apiKey, raw.apiKey));
  if (raw.model) conditions.push(eq(dailySpend.model, raw.model));
  if (raw.provider) conditions.push(eq(dailySpend.provider, raw.provider));
  return and(...conditions)!;
}

export function validateEnabled(raw: Record<string, string>): string | null {
  return raw.isEnabled !== undefined && !["true", "false"].includes(raw.isEnabled)
    ? "isEnabled must be true or false"
    : null;
}
