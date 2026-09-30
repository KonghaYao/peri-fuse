import type { ObservabilityFilterField } from "@/shared/components/observability-filter-bar";

export const FILTER_FIELDS: ObservabilityFilterField[] = [
  { key: "name", label: "Name" },
  { key: "userId", label: "User ID", title: "User ID contains this text" },
  { key: "sessionId", label: "Session ID", title: "Exact session ID match" },
  { key: "tags", label: "Tags", title: "Comma-separated tags; traces must contain all tags" },
  { key: "version", label: "Version", title: "Exact version match" },
  { key: "release", label: "Release", title: "Exact release match" },
  { key: "environment", label: "Environment" },
  { key: "fromTimestamp", label: "From timestamp", boundary: "start" },
  { key: "toTimestamp", label: "To timestamp", boundary: "end" },
];

export const FILTER_KEYS = FILTER_FIELDS.map((field) => field.key);

export type TraceFilters = {
  name?: string;
  userId?: string;
  sessionId?: string;
  tags?: string;
  version?: string;
  release?: string;
  environment?: string;
  fromTimestamp?: string;
  toTimestamp?: string;
};
