import type { ObservabilityFilterField } from "@/shared/components/observability-filter-bar";
import { OBSERVATION_TYPES } from "@/shared/lib/observation-types";

export const FILTER_FIELDS: ObservabilityFilterField[] = [
  { key: "name", label: "Name" },
  {
    key: "type",
    label: "Type",
    options: OBSERVATION_TYPES.map((value) => ({ value, label: value })),
  },
  { key: "traceId", label: "Trace ID", title: "Exact trace ID match" },
  { key: "userId", label: "User ID", title: "Exact trace user ID match" },
  { key: "version", label: "Version", title: "Exact version match" },
  {
    key: "parentObservationId",
    label: "Parent observation ID",
    title: "Exact parent observation ID match",
  },
  { key: "model", label: "Model", title: "Exact model name match" },
  { key: "environment", label: "Environment" },
  { key: "fromStartTime", label: "From start time", boundary: "start" },
  { key: "toStartTime", label: "To start time", boundary: "end" },
  {
    key: "level",
    label: "Level",
    options: ["DEBUG", "DEFAULT", "WARNING", "ERROR"].map((value) => ({ value, label: value })),
  },
];

export const FILTER_KEYS = FILTER_FIELDS.map((field) => field.key);

export type ObservationFilters = {
  name?: string;
  type?: string;
  traceId?: string;
  userId?: string;
  version?: string;
  parentObservationId?: string;
  model?: string;
  environment?: string;
  fromStartTime?: string;
  toStartTime?: string;
  level?: string;
};
