/**
 * In-Process Worker for Langfuse Lite Mode.
 *
 * In full mode, the worker runs as a separate Express.js process consuming
 * jobs from Redis/BullMQ queues. In lite mode, this module starts all
 * queue processors in-process using the InMemoryQueueAdapter — no Redis,
 * no separate process needed.
 *
 * Usage (from web's instrumentation or custom server):
 *   import { startInProcessWorker } from "@langfuse-lite/shared/src/server/worker/in-process-worker";
 *   await startInProcessWorker();
 */

import { getQueueAdapter, isLiteMode, shutdownAdapters } from "../adapters";
import { logger } from "../logger";
import { QueueName } from "../queues";

export interface InProcessWorkerOptions {
  /** Concurrency multiplier per queue (default: 1) */
  concurrencyMultiplier?: number;
  /** Whether to log job completions (default: false in production) */
  verboseLogging?: boolean;
}

let workerStarted = false;

/**
 * Starts the in-process worker. Only runs in lite mode.
 * Registers processors for all queues that the standalone worker handles.
 *
 * This is a no-op in full mode (returns immediately).
 */
export async function startInProcessWorker(options: InProcessWorkerOptions = {}): Promise<void> {
  if (!isLiteMode()) {
    logger.info("[InProcessWorker] Skipping — not in lite mode. Worker runs as separate process.");
    return;
  }

  if (workerStarted) {
    logger.warn("[InProcessWorker] Already started, skipping duplicate start.");
    return;
  }

  const { concurrencyMultiplier = 1, verboseLogging = false } = options;
  const queueAdapter = getQueueAdapter();

  logger.info("[InProcessWorker] Starting in-process queue processors...");

  // Register processors for each queue.
  // In lite mode, processors are simplified — they handle the core logic
  // without the full infrastructure dependencies (S3, ClickHouse, etc.)
  const queueConfigs: Array<{
    name: QueueName;
    concurrency: number;
    processor: (job: { data: unknown; id: string }) => Promise<void>;
  }> = [
    {
      name: QueueName.TraceUpsert,
      concurrency: 2 * concurrencyMultiplier,
      processor: async (job) => {
        if (verboseLogging) {
          logger.debug(`[InProcessWorker] trace-upsert: ${job.id}`);
        }
        // In lite mode, trace upserts are handled synchronously by the
        // SQLite telemetry adapter during ingestion. This processor is
        // a no-op placeholder for compatibility.
      },
    },
    {
      name: QueueName.IngestionQueue,
      concurrency: 4 * concurrencyMultiplier,
      processor: async (job) => {
        if (verboseLogging) {
          logger.debug(`[InProcessWorker] ingestion-queue: ${job.id}`);
        }
        // In lite mode, ingestion is processed synchronously via the
        // SQLite adapter. No async processing needed.
      },
    },
  ];

  for (const config of queueConfigs) {
    queueAdapter.createWorker(
      config.name,
      async (job) => {
        await config.processor(job);
      },
      { concurrency: config.concurrency },
    );
  }

  workerStarted = true;
  logger.info(
    `[InProcessWorker] Started ${queueConfigs.length} queue processors (concurrency multiplier: ${concurrencyMultiplier})`,
  );

  // Register shutdown handler
  const shutdown = async () => {
    logger.info("[InProcessWorker] Shutting down...");
    await shutdownAdapters();
    workerStarted = false;
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * Returns whether the in-process worker has been started.
 */
export function isInProcessWorkerRunning(): boolean {
  return workerStarted;
}
