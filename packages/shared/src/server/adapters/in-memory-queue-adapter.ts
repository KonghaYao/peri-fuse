/** Bounded process-local queues. Admission rejects overflow; accepted jobs run or emit failure. */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { logger } from "../logger";
import { decodeOwnedSnapshot, encodeOwnedSnapshot } from "../utils/owned-snapshot";
import type {
  QueueAdapter,
  QueueInstance,
  QueueJob,
  QueueJobOptions,
  QueueProcessor,
  QueueWorkerOptions,
  WorkerInstance,
} from "./types";

export interface InMemoryQueueLimits {
  maxJobs?: number;
  maxBytes?: number;
  maxFailed?: number;
  maxFailedBytes?: number;
  maxQueues?: number;
}

type InternalJob<T> = Omit<QueueJob<T>, "data"> & {
  snapshot: Buffer;
  bytes: number;
  delayTimer?: ReturnType<typeof setTimeout>;
};

class InMemoryQueue<T = unknown> implements QueueInstance<T> {
  private readonly emitter = new EventEmitter();
  private waiting: InternalJob<T>[] = [];
  private readonly jobs = new Map<string, InternalJob<T>>();
  private readonly active = new Set<InternalJob<T>>();
  private readonly executions = new Set<Promise<void>>();
  private failed: InternalJob<T>[] = [];
  private bytes = 0;
  private failedBytes = 0;
  private processor: QueueProcessor<T> | null = null;
  private concurrency = 1;
  private running = false;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    public readonly name: string,
    private readonly limits: Required<InMemoryQueueLimits>,
    private readonly defaults?: QueueJobOptions,
  ) {}

  setProcessor(processor: QueueProcessor<T>, opts?: QueueWorkerOptions): void {
    if (this.closed) throw new Error("Queue is closed");
    const concurrency = opts?.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency <= 0)
      throw new Error("Invalid queue concurrency");
    this.processor = processor;
    this.concurrency = concurrency;
    this.running = true;
    this.processNext();
  }

  isRunning(): boolean {
    return this.running && !this.closed;
  }

  async stopWorker(): Promise<void> {
    this.running = false;
    await Promise.allSettled([...this.executions]);
  }

  async add(name: string, data: T, opts?: QueueJobOptions): Promise<QueueJob<T>> {
    const [job] = await this.addBulk([{ name, data, opts }]);
    return job;
  }

  /** Check the entire batch before accepting any jobs, so partial success cannot be lost. */
  async addBulk(
    entries: Array<{ name: string; data: T; opts?: QueueJobOptions }>,
  ): Promise<QueueJob<T>[]> {
    if (this.closed) throw new Error("Queue is closed");
    const prepared = new Map<string, InternalJob<T>>();
    const result: InternalJob<T>[] = [];
    let addedBytes = 0;
    for (const entry of entries) {
      const opts = { ...this.defaults, ...entry.opts };
      const id = opts.jobId ?? randomUUID();
      const existing = this.jobs.get(id) ?? prepared.get(id);
      if (existing) {
        result.push(existing);
        continue;
      }
      const snapshot = encodeOwnedSnapshot({ data: entry.data, opts });
      const bytes = snapshot.byteLength * 2 + (id.length + entry.name.length) * 2 + 128;
      addedBytes += bytes;
      if (
        this.jobs.size + prepared.size + 1 > this.limits.maxJobs ||
        this.bytes + addedBytes > this.limits.maxBytes
      ) {
        throw new Error(`Queue ${this.name} capacity exceeded`);
      }
      const job = {
        id,
        name: entry.name,
        snapshot,
        opts: decodeOwnedSnapshot<{ opts: QueueJobOptions }>(snapshot).opts,
        bytes,
        attemptsMade: 0,
        timestamp: Date.now(),
      };
      prepared.set(id, job);
      result.push(job);
    }
    for (const job of prepared.values()) {
      this.jobs.set(job.id, job);
      this.bytes += job.bytes;
      this.schedule(job, job.opts.delay ?? 0);
    }
    this.processNext();
    return result.map((job) => this.toPublicJob(job));
  }

  async getWaitingCount(): Promise<number> {
    return this.jobs.size - this.active.size;
  }

  async getActiveCount(): Promise<number> {
    return this.active.size;
  }
  async getFailedCount(): Promise<number> {
    return this.failed.length;
  }

  async drain(): Promise<void> {
    this.waiting = [];
    for (const job of this.jobs.values()) {
      if (this.active.has(job)) continue;
      clearTimeout(job.delayTimer);
      this.finishFailure(job, new Error(`Queue ${this.name} drained`));
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.running = false;
    this.closePromise = this.drain().then(async () => {
      await Promise.allSettled([...this.executions]);
      this.failed = [];
      this.failedBytes = 0;
      this.processor = null;
      this.emitter.removeAllListeners();
    });
    return this.closePromise;
  }

  on(event: "error", handler: (error: Error) => void): void;
  on(event: "completed", handler: (job: QueueJob) => void): void;
  on(event: "failed", handler: (job: QueueJob, error: Error) => void): void;
  on(event: string, handler: (...args: never[]) => void): void {
    this.emitter.on(event, handler);
  }

  private schedule(job: InternalJob<T>, delay: number): void {
    if (delay > 0) {
      job.delayTimer = setTimeout(
        () => {
          job.delayTimer = undefined;
          if (this.closed || !this.jobs.has(job.id)) return;
          this.waiting.push(job);
          this.processNext();
        },
        Math.min(delay, 2_147_483_647),
      );
    } else this.waiting.push(job);
  }

  private processNext(): void {
    while (
      this.isRunning() &&
      this.processor &&
      this.waiting.length &&
      this.active.size < this.concurrency
    ) {
      const job = this.waiting.shift()!;
      this.active.add(job);
      const execution = this.executeJob(job, this.processor);
      this.executions.add(execution);
      void execution.finally(() => this.executions.delete(execution));
    }
  }

  private async executeJob(job: InternalJob<T>, processor: QueueProcessor<T>): Promise<void> {
    try {
      await processor(this.toPublicJob(job));
      this.release(job);
      this.emit("completed", this.toPublicJob(job));
    } catch (error) {
      job.attemptsMade++;
      this.active.delete(job);
      if (!this.closed && job.attemptsMade < (job.opts.attempts ?? 1)) {
        const backoff = job.opts.backoff;
        const delay =
          backoff?.type === "exponential"
            ? backoff.delay * 2 ** (job.attemptsMade - 1)
            : (backoff?.delay ?? 1000);
        this.schedule(job, delay);
      } else {
        this.finishFailure(job, error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      this.processNext();
    }
  }

  private release(job: InternalJob<T>): void {
    this.active.delete(job);
    if (this.jobs.delete(job.id)) this.bytes -= job.bytes;
  }

  private finishFailure(job: InternalJob<T>, error: Error): void {
    this.release(job);
    const requested = job.opts.removeOnFail;
    const keep =
      requested === true
        ? 0
        : typeof requested === "number"
          ? Math.max(0, Math.min(requested, this.limits.maxFailed))
          : this.limits.maxFailed;
    if (keep && job.bytes <= this.limits.maxFailedBytes) {
      this.failed.push(job);
      this.failedBytes += job.bytes;
    }
    while (
      this.failed.length > (keep || this.limits.maxFailed) ||
      this.failedBytes > this.limits.maxFailedBytes
    ) {
      this.failedBytes -= this.failed.shift()!.bytes;
    }
    this.emit("failed", this.toPublicJob(job), error);
    logger.warn(`[InMemoryQueue:${this.name}] Job ${job.id} failed: ${error.message}`);
  }

  private emit(event: string, ...args: unknown[]): void {
    try {
      this.emitter.emit(event, ...args);
    } catch (error) {
      logger.error(`[InMemoryQueue:${this.name}] ${event} listener failed`, error);
    }
  }

  private toPublicJob(job: InternalJob<T>): QueueJob<T> {
    const { id, name, attemptsMade, timestamp } = job;
    // Processor and event consumers own their copies; they cannot grow delayed
    // or failed retained jobs, or modify the private retry configuration.
    const { data, opts } = decodeOwnedSnapshot<{ data: T; opts: QueueJobOptions }>(job.snapshot);
    return { id, name, data, attemptsMade, opts, timestamp };
  }
}

class InMemoryWorker implements WorkerInstance {
  constructor(private readonly queue: InMemoryQueue) {}
  close(): Promise<void> {
    return this.queue.stopWorker();
  }
  isRunning(): boolean {
    return this.queue.isRunning();
  }
}

export class InMemoryQueueAdapter implements QueueAdapter {
  private readonly queues = new Map<string, InMemoryQueue>();
  private readonly limits: Required<InMemoryQueueLimits>;
  private closed = false;

  constructor(limits: InMemoryQueueLimits = {}) {
    this.limits = {
      maxJobs: 1000,
      maxBytes: 16 * 1024 * 1024,
      maxFailed: 100,
      maxFailedBytes: 1024 * 1024,
      maxQueues: 128,
      ...limits,
    };
    for (const value of Object.values(this.limits)) {
      if (!Number.isFinite(value) || value < 0) throw new Error("Invalid queue limit");
    }
  }

  getQueue<T = unknown>(name: string, defaultJobOptions?: QueueJobOptions): QueueInstance<T> {
    if (this.closed) throw new Error("Queue adapter is closed");
    if (!this.queues.has(name)) {
      if (this.queues.size >= this.limits.maxQueues)
        throw new Error("Queue adapter capacity exceeded");
      this.queues.set(name, new InMemoryQueue(name, this.limits, defaultJobOptions));
    }
    return this.queues.get(name)! as QueueInstance<T>;
  }

  createWorker<T = unknown>(
    name: string,
    processor: QueueProcessor<T>,
    opts?: QueueWorkerOptions,
  ): WorkerInstance {
    this.getQueue(name);
    const queue = this.queues.get(name)!;
    queue.setProcessor(processor as QueueProcessor, opts);
    return new InMemoryWorker(queue);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}
