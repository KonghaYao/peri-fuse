/**
 * Transaction ownership and retry policy for the optional `bun:sqlite` engine.
 *
 * One Database owns one native connection, so every native call is serialized
 * by a FIFO gate; a transaction holds the parent gate for the whole
 * BEGIN..COMMIT window and gives its callback a handle with its own gate.
 * Ownership is tracked with AsyncLocalStorage because a synchronous SQL call
 * still does not make the surrounding async callback mutually exclusive.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createDatabaseError } from "./errors";

/** Serializes native access in acquisition order. */
export class FifoGate {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  get pending(): number {
    return this.waiting;
  }

  acquire(): Promise<() => void> {
    this.waiting += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(() => {
      this.waiting -= 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    });
  }
}

export interface TransactionScope {
  databaseId: number;
  transactionId: number;
  active: boolean;
}

export const transactionScope = new AsyncLocalStorage<TransactionScope>();

/**
 * Rejects parent-database use inside a transaction callback (or from a task
 * that inherited the finished scope) instead of queueing behind the gate the
 * callback already owns.
 */
export function assertNoTransactionReentry(databaseId: number): void {
  const scope = transactionScope.getStore();
  if (scope?.databaseId === databaseId)
    throw createDatabaseError(
      "PERIFUSE_TRANSACTION_REENTRY",
      "The database is already in a transaction; use the transaction handle",
    );
}

export interface RetryClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  random(): number;
}

export const defaultRetryClock: RetryClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: () => Math.random(),
};

export const BEGIN_RETRY_BUDGET_MS = 5000;
export const BEGIN_RETRY_BASE_MS = 10;
export const BEGIN_RETRY_MAX_MS = 200;
export const BEGIN_RETRY_JITTER_MS = 25;
export const SQLITE_BUSY = 5;
export const SQLITE_BUSY_SNAPSHOT = 517;

function errorNumber(error: unknown, key: "errno" | "code"): unknown {
  return error && typeof error === "object" ? (error as Record<string, unknown>)[key] : undefined;
}

/**
 * Only the primary `SQLITE_BUSY` code is retryable. `SQLITE_BUSY_SNAPSHOT` must
 * reach the caller because the whole DEFERRED transaction needs a redo, and
 * message text is never used for the decision.
 */
export function isRetryableBusy(error: unknown): boolean {
  const errno = errorNumber(error, "errno");
  if (typeof errno === "number") {
    if (errno === SQLITE_BUSY_SNAPSHOT) return false;
    return (errno & 0xff) === SQLITE_BUSY;
  }
  const code = errorNumber(error, "code");
  return typeof code === "string" && code.startsWith("SQLITE_BUSY") && !code.includes("SNAPSHOT");
}

function busyTimeoutError(attempts: number, elapsedMs: number, lastError: unknown): Error {
  const source = lastError as { code?: unknown; errno?: unknown; message?: unknown } | undefined;
  const message =
    typeof source?.message === "string" ? source.message : "SQLite database is locked";
  const error = new Error(`${message} (attempts=${attempts}, elapsedMs=${elapsedMs})`) as Error & {
    attempts: number;
    elapsedMs: number;
  };
  if (typeof source?.code === "string") (error as { code?: string }).code = source.code;
  if (typeof source?.errno === "number") (error as { errno?: number }).errno = source.errno;
  error.cause = lastError;
  error.attempts = attempts;
  error.elapsedMs = elapsedMs;
  return error;
}

/**
 * Runs `attempt` while SQLite reports the primary BUSY code. Callers must only
 * pass side-effect-free work (BEGIN, the WAL activation PRAGMA): callbacks,
 * COMMIT, `exec` and ordinary statements are never replayed.
 */
export async function retryWhileBusy<T>(
  attempt: () => T,
  clock: RetryClock = defaultRetryClock,
  budgetMs: number = BEGIN_RETRY_BUDGET_MS,
): Promise<T> {
  const started = clock.now();
  let attempts = 0;
  let lastError: unknown;
  for (;;) {
    try {
      return attempt();
    } catch (error) {
      if (!isRetryableBusy(error)) throw error;
      lastError = error;
      attempts += 1;
      const remaining = budgetMs - (clock.now() - started);
      if (remaining <= 0) break;
      const backoff =
        Math.min(BEGIN_RETRY_BASE_MS * 2 ** (attempts - 1), BEGIN_RETRY_MAX_MS) +
        clock.random() * BEGIN_RETRY_JITTER_MS;
      await clock.sleep(Math.min(backoff, remaining));
    }
  }
  throw busyTimeoutError(attempts, clock.now() - started, lastError);
}

export type TransactionMode = "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE";

/**
 * Records operations a connection or transaction has already accepted, so a
 * close (or COMMIT) can wait for them instead of racing their native calls.
 */
export class PendingOperations {
  private readonly pending = new Set<Promise<unknown>>();
  private failure: unknown;

  get size(): number {
    return this.pending.size;
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const forget = () => {
      this.pending.delete(promise);
    };
    void promise.then(forget, (error) => {
      this.failure = error;
      forget();
    });
    return promise;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  takeFailure(): unknown {
    const failure = this.failure;
    this.failure = undefined;
    return failure;
  }
}
