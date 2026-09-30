import type { ObservabilityFilterField } from "@/shared/components/observability-filter-bar";
import type { ScoreListParams } from "@/shared/lib/types";

export const FILTER_FIELDS: ObservabilityFilterField[] = [
  { key: "name", label: "Name" },
  {
    key: "source",
    label: "Source",
    options: ["API", "EVAL", "ANNOTATION"].map((value) => ({ value, label: value })),
  },
  { key: "traceId", label: "Trace ID", title: "Exact trace ID match" },
  { key: "userId", label: "User ID", title: "Exact trace user ID match" },
  { key: "configId", label: "Config ID", title: "Exact score config ID match" },
  { key: "environment", label: "Environment" },
  { key: "fromTimestamp", label: "From timestamp", boundary: "start" },
  { key: "toTimestamp", label: "To timestamp", boundary: "end" },
  {
    key: "dataType",
    label: "Data type",
    options: ["NUMERIC", "CATEGORICAL", "BOOLEAN"].map((value) => ({ value, label: value })),
  },
  {
    key: "operator",
    label: "Operator",
    title: "Numeric comparison; defaults to = when a value is entered",
    defaultValue: "=",
    allLabel: "Default (=)",
    options: ["<", ">", "<=", ">=", "!=", "="].map((value) => ({ value, label: value })),
  },
  {
    key: "value",
    label: "Value",
    inputType: "number",
    title: "Numeric score threshold; defaults to exact equality",
  },
];

export const FILTER_KEYS = FILTER_FIELDS.map((field) => field.key);

export type ScoreFilters = {
  name?: string;
  source?: string;
  traceId?: string;
  userId?: string;
  configId?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
  dataType?: string;
  operator?: ScoreListParams["operator"];
  value?: string;
};
