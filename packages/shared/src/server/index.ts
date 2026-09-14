/**
 * Server barrel export — lite-mode subset.
 *
 * Only modules that work without ClickHouse, Redis, S3, BullMQ, or AI SDKs
 * are exported here.
 */

export * from "../server/ingestion/modelMatch";
// Ingestion
export * from "../server/ingestion/types";
export * from "../server/ingestion/validateAndInflateScore";
export * from "../utils/IORepresentation/chatML/types";
export * from "./adapters";

// Auth
export * from "./auth/apiKeyCache";
export * from "./auth/apiKeys";
export * from "./auth/credentials";
export * from "./auth/types";
export * from "./auth/userProjectRoleAuth";
// Cache (local in-memory only)
export * from "./cache";
// Deletion guard
export * from "./deletionGuard";
export * from "./filterToPrisma";
export * from "./ingestion/extractToolsBackend";
export * from "./ingestion/ingestionAttribution";
export * from "./ingestion/processEventBatch";
// Instrumentation stubs (no-ops in lite mode)
export {
  instrumentAsync,
  instrumentSync,
  recordDistribution,
  recordIncrement,
  traceException,
} from "./instrumentation";
// Core infrastructure
export * from "./logger";
export * from "./orderByToPrisma";
// OTel
export * from "./otel";
export * from "./otel/utils";
// Outbound URL validation
export * from "./outbound-url";
// Query filter utilities
export {
  ArrayOptionsFilter,
  BooleanFilter,
  CategoryOptionsFilter,
  DateTimeFilter,
  FilterList,
  NullFilter,
  NumberFilter,
  StringFilter,
  StringOptionsFilter,
} from "./queries/clickhouse-sql/clickhouse-filter";
export type { ObservationPriceFields } from "./queries/createGenerationsQuery";
// Public API filter stubs
export {
  convertApiProvidedFilterToClickhouseFilter,
  createPublicApiObservationsColumnMapping,
  createPublicApiTracesColumnMapping,
  deriveFilters,
} from "./queries/public-api-filter-builder";
export * from "./queues";
// OTel user tracking stub
export { markProjectAsOtelUser } from "./redis/otelUserTracking";
// Redis stubs
export { redis, safeMultiDel, scanKeys } from "./redis/redis";
// Repositories
export * from "./repositories";
export { SCORE_TO_TRACE_OBSERVATIONS_INTERVAL } from "./repositories/constants";
export * from "./repositories/definitions";
export * from "./repositories/observations";
export { scoreDomainToV3 } from "./repositories/scores";
export * from "./repositories/traces";
// Trace retrieval
export { getTraceByIdFromTracesTable as getTraceById } from "./repositories/traces";
// S3 stubs
export { getS3EventStorageClient } from "./s3";
export * from "./session-search";
// Table mappings
export * from "./tableMappings";
export * from "./utils/compareVersions";
export * from "./utils/DatabaseReadStream";
export * from "./utils/headerUtils";
export * from "./utils/metadata_conversion";
export * from "./utils/rendering";
export * from "./utils/sqlCompat";
export * from "./utils/sqlLike";
// Utils
export * from "./utils/traceId";
export * from "./utils/transforms";
