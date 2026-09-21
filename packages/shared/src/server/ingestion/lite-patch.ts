import { createHash } from "node:crypto";

// 只用于 ingestion：缺失/null 沿用已有 trace 的非覆盖语义，默认值仅用于插入。
const fields: Record<string, string[]> = {
  timestamp: ["timestamp"],
  name: ["name"],
  user_id: ["userId"],
  metadata: ["metadata"],
  release: ["release"],
  version: ["version"],
  public: ["public"],
  tags: ["tags"],
  input: ["input"],
  output: ["output"],
  session_id: ["sessionId"],
  environment: ["environment"],
  trace_id: ["traceId"],
  type: ["type"],
  parent_observation_id: ["parentObservationId"],
  start_time: ["startTime"],
  end_time: ["endTime"],
  model: ["model"],
  level: ["level"],
  status_message: ["statusMessage"],
  completion_start_time: ["completionStartTime"],
  model_parameters: ["modelParameters"],
  usage_details: ["usage", "usageDetails"],
  provided_usage_details: ["usage", "usageDetails"],
  cost_details: ["costDetails"],
  provided_cost_details: ["costDetails"],
};

export function liteUpdateColumns(
  raw: Record<string, unknown>,
  parsed: Record<string, unknown>,
): string[] {
  return [
    "updated_at",
    "event_ts",
    ...Object.entries(fields)
      .filter(([, names]) => names.some((name) => raw[name] != null && parsed[name] != null))
      .map(([column]) => column),
  ];
}

/** 无实体 ID 时，以项目、事件类型和 envelope ID 提供稳定的重试身份。 */
export function liteEntityId(projectId: string, type: string, eventId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([projectId, type, eventId]))
    .digest("hex");
}
