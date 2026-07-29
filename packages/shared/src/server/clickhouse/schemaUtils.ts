/** ClickHouse schema utilities for lite mode. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { eventTypes } from "../ingestion/types";

export function getClickhouseTableForEvents(_projectId?: string): string {
  return "events";
}
export function getClickhouseTableName(_projectId?: string): string {
  return "observations";
}
export type EventBucketPath = string;
export function getEventBucketPath(_projectId: string, _eventId: string): string {
  return "";
}

export type IngestionEntityTypes =
  | "trace"
  | "observation"
  | "score"
  | "sdk_log"
  | "dataset_run_item";

export function getClickhouseEntityType(eventType: string): IngestionEntityTypes {
  switch (eventType) {
    case eventTypes.TRACE_CREATE:
      return "trace";
    case eventTypes.OBSERVATION_CREATE:
    case eventTypes.OBSERVATION_UPDATE:
    case eventTypes.EVENT_CREATE:
    case eventTypes.SPAN_CREATE:
    case eventTypes.SPAN_UPDATE:
    case eventTypes.GENERATION_CREATE:
    case eventTypes.GENERATION_UPDATE:
    case eventTypes.AGENT_CREATE:
    case eventTypes.TOOL_CREATE:
    case eventTypes.CHAIN_CREATE:
    case eventTypes.RETRIEVER_CREATE:
    case eventTypes.EVALUATOR_CREATE:
    case eventTypes.EMBEDDING_CREATE:
    case eventTypes.GUARDRAIL_CREATE:
      return "observation";
    case eventTypes.SCORE_CREATE:
      return "score";
    case eventTypes.DATASET_RUN_ITEM_CREATE:
    case "dataset_run_item-create":
      return "dataset_run_item";
    case eventTypes.SDK_LOG:
      return "sdk_log";
    default:
      return "observation";
  }
}
