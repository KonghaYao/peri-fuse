/**
 * Adapter layer type definitions.
 *
 * These interfaces abstract the infrastructure dependencies (ClickHouse,
 * Redis/BullMQ, S3) so that Langfuse can run in two modes:
 *
 * - **full** (default): production-grade stack with ClickHouse, Redis, S3.
 * - **lite**: zero-external-dependency mode using SQLite, in-memory queues,
 *   and local filesystem storage.
 *
 * The active mode is controlled by the `LANGFUSE_MODE` environment variable.
 */

import type { Readable } from "node:stream";

// ============================================================================
// Mode
// ============================================================================

export type LangfuseMode = "full" | "lite";

// ============================================================================
// Telemetry Database Adapter (abstracts ClickHouse / SQLite)
// ============================================================================

/**
 * Options for telemetry queries. Mirrors the existing `ClickhouseQueryOpts`
 * but is backend-agnostic.
 */
export interface TelemetryQueryOpts {
  query: string;
  params?: Record<string, unknown>;
  tags?: Record<string, string>;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Options for telemetry insert/upsert operations.
 */
export interface TelemetryInsertOpts<T = Record<string, unknown>> {
  table: string;
  records: T[];
  tags?: Record<string, string>;
}

/**
 * Abstract interface for the telemetry data store.
 *
 * - Full mode: backed by ClickHouse
 * - Lite mode: backed by SQLite (better-sqlite3)
 */
export interface TelemetryDBAdapter {
  /** Execute a read query and return all rows. */
  query<T = Record<string, unknown>>(opts: TelemetryQueryOpts): Promise<T[]>;

  /** Execute a write command (INSERT, UPDATE, DELETE, DDL). */
  command(opts: TelemetryQueryOpts): Promise<{ changes: number }>;

  /** Insert records into a table. */
  insert<T = Record<string, unknown>>(opts: TelemetryInsertOpts<T>): Promise<void>;

  /**
   * Insert records with field-level merge semantics: on primary-key conflict,
   * only overwrite columns whose incoming value is non-null. This mirrors
   * ClickHouse ReplacingMergeTree coalesce behaviour for trace upserts.
   * Default implementation falls back to plain insert.
   */
  mergeInsert?<T = Record<string, unknown>>(opts: TelemetryInsertOpts<T>): Promise<void>;

  /** Stream query results row by row. */
  queryStream<T = Record<string, unknown>>(opts: TelemetryQueryOpts): AsyncGenerator<T>;

  /** Health check – returns true if the database is reachable. */
  healthCheck(): Promise<boolean>;

  /** Gracefully close all connections. */
  close(): Promise<void>;
}

// ============================================================================
// Queue Adapter (abstracts Redis/BullMQ / In-Memory)
// ============================================================================

export interface QueueJobOptions {
  /** Number of retry attempts */
  attempts?: number;
  /** Backoff configuration */
  backoff?: {
    type: "exponential" | "fixed";
    delay: number;
  };
  /** Delay before the job becomes active (ms) */
  delay?: number;
  /** Job priority (lower = higher priority) */
  priority?: number;
  /** Remove job from queue on completion */
  removeOnComplete?: boolean | number;
  /** Keep N failed jobs for debugging */
  removeOnFail?: boolean | number;
  /** Job ID (for deduplication) */
  jobId?: string;
}

export interface QueueWorkerOptions {
  /** Maximum concurrent job processing */
  concurrency?: number;
  /** Rate limiter */
  limiter?: {
    max: number;
    duration: number;
  };
  /** Lock duration in ms */
  lockDuration?: number;
  /** Stalled interval in ms */
  stalledInterval?: number;
  /** Max stalled count before failing */
  maxStalledCount?: number;
}

export interface QueueJob<T = unknown> {
  id: string;
  name: string;
  data: T;
  attemptsMade: number;
  opts: QueueJobOptions;
  timestamp: number;
}

export type QueueProcessor<T = unknown> = (job: QueueJob<T>) => Promise<void>;

export interface QueueEvents {
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "completed", handler: (job: QueueJob) => void): void;
  on(event: "failed", handler: (job: QueueJob, error: Error) => void): void;
}

/**
 * Abstract queue interface – mirrors the BullMQ Queue API subset used by
 * Langfuse.
 */
export interface QueueInstance<T = unknown> extends QueueEvents {
  add(name: string, data: T, opts?: QueueJobOptions): Promise<QueueJob<T>>;
  addBulk(jobs: Array<{ name: string; data: T; opts?: QueueJobOptions }>): Promise<QueueJob<T>[]>;
  getWaitingCount(): Promise<number>;
  getActiveCount(): Promise<number>;
  getFailedCount(): Promise<number>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Abstract worker interface – mirrors the BullMQ Worker API subset.
 */
export interface WorkerInstance {
  close(): Promise<void>;
  isRunning(): boolean;
}

/**
 * Abstract interface for the queue system.
 *
 * - Full mode: backed by Redis + BullMQ
 * - Lite mode: backed by in-process EventEmitter queues
 */
export interface QueueAdapter {
  /**
   * Get or create a queue instance.
   * @param name - Queue name (e.g. "ingestion-queue")
   * @param defaultJobOptions - Default options for jobs added to this queue
   */
  getQueue<T = unknown>(name: string, defaultJobOptions?: QueueJobOptions): QueueInstance<T> | null;

  /**
   * Create a worker that processes jobs from a queue.
   * @param name - Queue name to listen on
   * @param processor - Async function to process each job
   * @param opts - Worker options (concurrency, limiter, etc.)
   */
  createWorker<T = unknown>(
    name: string,
    processor: QueueProcessor<T>,
    opts?: QueueWorkerOptions,
  ): WorkerInstance | null;

  /** Gracefully shut down all queues and workers. */
  close(): Promise<void>;
}

// ============================================================================
// Cache Adapter (abstracts Redis cache / LRU in-memory)
// ============================================================================

/**
 * Abstract interface for caching.
 *
 * - Full mode: backed by Redis
 * - Lite mode: backed by LRU in-memory cache
 */
export interface CacheAdapter {
  get<T = string>(key: string): Promise<T | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Get multiple keys at once */
  mget(keys: string[]): Promise<(string | null)[]>;
  /** Set multiple keys at once */
  mset(entries: Array<{ key: string; value: string; ttlSeconds?: number }>): Promise<void>;
  /** Increment a counter */
  incr(key: string): Promise<number>;
  /** Set expiry on existing key */
  expire(key: string, ttlSeconds: number): Promise<void>;
  /** Close the cache connection */
  close(): Promise<void>;
}

// ============================================================================
// Storage Adapter (abstracts S3/Azure/GCS / Local filesystem)
// ============================================================================

/**
 * Abstract interface for object/blob storage.
 *
 * This mirrors the existing `StorageService` interface so that the local
 * filesystem adapter is a drop-in replacement.
 *
 * - Full mode: backed by S3/MinIO/Azure/GCS (existing StorageService)
 * - Lite mode: backed by local filesystem
 */
export interface StorageAdapter {
  uploadFile(params: {
    fileName: string;
    fileType: string;
    data: Readable | string;
  }): Promise<void>;

  uploadJson(
    path: string,
    body: Record<string, unknown>[] | Record<string, unknown>,
  ): Promise<void>;

  download(path: string): Promise<string>;

  listFiles(prefix: string): Promise<{ file: string; createdAt: Date }[]>;

  getSignedUrl(fileName: string, ttlSeconds: number, asAttachment?: boolean): Promise<string>;

  getSignedUploadUrl(params: {
    path: string;
    ttlSeconds: number;
    sha256Hash: string;
    contentType: string;
    contentLength: number;
  }): Promise<string>;

  deleteFiles(paths: string[]): Promise<void>;

  fileExists(path: string): Promise<boolean>;
}
