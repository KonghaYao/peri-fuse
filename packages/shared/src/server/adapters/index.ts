/**
 * Adapter layer – unified exports.
 *
 * Usage:
 * ```ts
 * import { getTelemetryDB, getQueueAdapter, isLiteMode } from "@peri-fuse/shared/src/server/adapters";
 * ```
 */

// Factory functions
export {
  getCacheAdapter,
  getLangfuseMode,
  getQueueAdapter,
  getStorageAdapter,
  getTelemetryDB,
  isFullMode,
  isLiteMode,
  resetAdapters,
  shutdownAdapters,
} from "./factory";
export { InMemoryCacheAdapter } from "./in-memory-cache-adapter";
export { InMemoryQueueAdapter } from "./in-memory-queue-adapter";
export { LocalStorageAdapter } from "./local-storage-adapter";
// Concrete implementations (lite-mode only)
export {
  SQLiteTelemetryAdapter,
  TRACE_METRICS_CACHE_CREATION_TOKENS_SQL,
  TRACE_METRICS_CACHED_TOKENS_SQL,
  TRACE_METRICS_GROSS_INPUT_TOKENS_SQL,
} from "./sqlite-telemetry-adapter";
export {
  TelemetryQueryError,
  throwIfTelemetryQueryFailed,
  withTelemetryQuerySignal,
} from "./telemetry-query-context";
// Types
export type {
  CacheAdapter,
  LangfuseMode,
  QueueAdapter,
  QueueInstance,
  QueueJob,
  QueueJobOptions,
  QueueProcessor,
  QueueWorkerOptions,
  StorageAdapter,
  TelemetryDBAdapter,
  TelemetryInsertOpts,
  TelemetryQueryOpts,
  WorkerInstance,
} from "./types";
