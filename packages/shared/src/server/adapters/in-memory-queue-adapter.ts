/**
 * In-memory queue adapter.
 * Replaces Redis/BullMQ with process-local EventEmitter-based queues in lite mode.
 *
 * Limitations vs BullMQ:
 * - Jobs are lost on process restart (acceptable for local dev)
 * - No distributed locking or cross-process coordination
 * - No persistence / dead-letter queue
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { logger } from "../logger";
import type {
  QueueAdapter,
  QueueInstance,
  QueueJob,
  QueueJobOptions,
  QueueProcessor,
  QueueWorkerOptions,
  WorkerInstance,
} from "./types";

// ============================================================================
// In-Memory Job
// ============================================================================

interface InternalJob<T = unknown> {
  id: string;
  name: string;
  data: T;
  opts: QueueJobOptions;
  attemptsMade: number;
  timestamp: number;
  delayTimer?: ReturnType<typeof setTimeout>;
}

// ============================================================================
// In-Memory Queue
// ============================================================================

class InMemoryQueue<T = unknown> implements QueueInstance<T> {
  private emitter = new EventEmitter();
  private waiting: InternalJob<T>[] = [];
  private active: InternalJob<T>[] = [];
  private failed: InternalJob<T>[] = [];
  private processor: QueueProcessor<T> | null = null;
  private workerOpts: QueueWorkerOptions;
  private running = false;
  private processing = false;

  constructor(
    public readonly name: string,
    private defaultJobOptions?: QueueJobOptions,
    workerOpts?: QueueWorkerOptions,
  ) {
    this.workerOpts = workerOpts ?? {};
    // Allow many listeners (one per event type)
    this.emitter.setMaxListeners(50);
  }

  setProcessor(processor: QueueProcessor<T>, opts?: QueueWorkerOptions): void {
    this.processor = processor;
    if (opts) this.workerOpts = opts;
    this.running = true;
    // Start processing any waiting jobs
    void this.processNext();
  }

  async add(name: string, data: T, opts?: QueueJobOptions): Promise<QueueJob<T>> {
    const job: InternalJob<T> = {
      id: opts?.jobId ?? randomUUID(),
      name,
      data,
      opts: { ...this.defaultJobOptions, ...opts },
      attemptsMade: 0,
      timestamp: Date.now(),
    };

    const delay = job.opts.delay ?? 0;
    if (delay > 0) {
      job.delayTimer = setTimeout(() => {
        this.waiting.push(job);
        void this.processNext();
      }, delay);
    } else {
      this.waiting.push(job);
      void this.processNext();
    }

    return this.toPublicJob(job);
  }

  async addBulk(
    jobs: Array<{ name: string; data: T; opts?: QueueJobOptions }>,
  ): Promise<QueueJob<T>[]> {
    const results: QueueJob<T>[] = [];
    for (const j of jobs) {
      results.push(await this.add(j.name, j.data, j.opts));
    }
    return results;
  }

  async getWaitingCount(): Promise<number> {
    return this.waiting.length;
  }

  async getActiveCount(): Promise<number> {
    return this.active.length;
  }

  async getFailedCount(): Promise<number> {
    return this.failed.length;
  }

  async drain(): Promise<void> {
    this.waiting = [];
  }

  async close(): Promise<void> {
    this.running = false;
    // Clear any pending delay timers
    for (const job of this.waiting) {
      if (job.delayTimer) clearTimeout(job.delayTimer);
    }
    this.waiting = [];
    this.emitter.removeAllListeners();
  }

  on(event: "error", handler: (error: Error) => void): void;
  on(event: "completed", handler: (job: QueueJob) => void): void;
  on(event: "failed", handler: (job: QueueJob, error: Error) => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    // The catch-all implementation signature uses `never[]` params; widen to
    // the EventEmitter's `any[]` listener shape for the pass-through.
    this.emitter.on(event, handler as (...args: any[]) => void);
  }

  // --------------------------------------------------------------------------
  // Internal processing loop
  // --------------------------------------------------------------------------

  private async processNext(): Promise<void> {
    if (!this.running || !this.processor || this.processing) return;

    const concurrency = this.workerOpts.concurrency ?? 1;
    if (this.active.length >= concurrency) return;
    if (this.waiting.length === 0) return;

    this.processing = true;

    try {
      while (this.running && this.waiting.length > 0 && this.active.length < concurrency) {
        const job = this.waiting.shift()!;
        this.active.push(job);

        // Fire-and-forget processing to allow concurrency
        void this.executeJob(job);
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeJob(job: InternalJob<T>): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;

    try {
      await this.processor?.(this.toPublicJob(job));
      // Success
      this.active = this.active.filter((j) => j.id !== job.id);
      this.emitter.emit("completed", this.toPublicJob(job));
      // Process next job
      void this.processNext();
    } catch (error) {
      job.attemptsMade++;

      if (job.attemptsMade < maxAttempts) {
        // Retry with backoff
        const backoff = job.opts.backoff;
        const delay =
          backoff?.type === "exponential"
            ? backoff.delay * 2 ** (job.attemptsMade - 1)
            : (backoff?.delay ?? 1000);

        this.active = this.active.filter((j) => j.id !== job.id);

        setTimeout(() => {
          this.waiting.push(job);
          void this.processNext();
        }, delay);
      } else {
        // Failed permanently
        this.active = this.active.filter((j) => j.id !== job.id);
        this.failed.push(job);
        this.emitter.emit("failed", this.toPublicJob(job), error);
        logger.warn(
          `[InMemoryQueue:${this.name}] Job ${job.id} failed after ${job.attemptsMade} attempts`,
        );
        // Process next job
        void this.processNext();
      }
    }
  }

  private toPublicJob(job: InternalJob<T>): QueueJob<T> {
    return {
      id: job.id,
      name: job.name,
      data: job.data,
      attemptsMade: job.attemptsMade,
      opts: job.opts,
      timestamp: job.timestamp,
    };
  }
}

// ============================================================================
// In-Memory Worker
// ============================================================================

class InMemoryWorker implements WorkerInstance {
  // biome-ignore lint/complexity/noUselessConstructor: parameter kept for interface consistency
  constructor(_queue: InMemoryQueue) {}

  async close(): Promise<void> {
    // Worker lifecycle is tied to the queue in lite mode
  }

  isRunning(): boolean {
    return true;
  }
}

// ============================================================================
// In-Memory Queue Adapter
// ============================================================================

export class InMemoryQueueAdapter implements QueueAdapter {
  private queues: Map<string, InMemoryQueue> = new Map();

  getQueue<T = unknown>(
    name: string,
    defaultJobOptions?: QueueJobOptions,
  ): QueueInstance<T> | null {
    if (!this.queues.has(name)) {
      this.queues.set(name, new InMemoryQueue(name, defaultJobOptions));
    }
    return this.queues.get(name)! as unknown as QueueInstance<T>;
  }

  createWorker<T = unknown>(
    name: string,
    processor: QueueProcessor<T>,
    opts?: QueueWorkerOptions,
  ): WorkerInstance | null {
    // Ensure queue exists
    if (!this.queues.has(name)) {
      this.queues.set(name, new InMemoryQueue(name));
    }
    const queue = this.queues.get(name)!;
    queue.setProcessor(processor as QueueProcessor, opts);
    return new InMemoryWorker(queue);
  }

  async close(): Promise<void> {
    const promises = Array.from(this.queues.values()).map((q) => q.close());
    await Promise.allSettled(promises);
    this.queues.clear();
  }
}
