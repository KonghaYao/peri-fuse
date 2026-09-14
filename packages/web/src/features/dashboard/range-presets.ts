import type { DashboardQueryParams } from "@/shared/lib/types";

/** Quick time-range presets for the dashboard. `hours === null` means all time. */
export const RANGE_PRESETS = [
  { key: "24h", label: "24h", hours: 24 },
  { key: "7d", label: "7d", hours: 24 * 7 },
  { key: "30d", label: "30d", hours: 24 * 30 },
  { key: "all", label: "All", hours: null },
] as const;

export type RangeKey = (typeof RANGE_PRESETS)[number]["key"];

export function resolveRange(raw: string | string[] | undefined): RangeKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return RANGE_PRESETS.some((preset) => preset.key === value) ? (value as RangeKey) : "30d";
}

export function queryParamsForRange(range: RangeKey): DashboardQueryParams {
  const preset = RANGE_PRESETS.find((p) => p.key === range);
  if (!preset?.hours) return {};
  return { from: new Date(Date.now() - preset.hours * 3_600_000).toISOString() };
}
