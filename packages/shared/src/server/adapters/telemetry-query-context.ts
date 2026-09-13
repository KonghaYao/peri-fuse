import { AsyncLocalStorage } from "node:async_hooks";

interface QueryContext {
  signal?: AbortSignal;
  failure?: TelemetryQueryError;
  active: boolean;
}
const queryContext = new AsyncLocalStorage<QueryContext>();

/** Retain sync callers while checking swallowed resource failures after async handlers finish. */
export function withTelemetryQuerySignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T>;
export function withTelemetryQuerySignal<T>(signal: AbortSignal, fn: () => T): T;
export function withTelemetryQuerySignal<T>(
  signal: AbortSignal,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const context: QueryContext = { signal, active: true };
  return queryContext.run(context, () => {
    const clear = () => {
      context.active = false;
      context.signal = undefined;
      context.failure = undefined;
    };
    const finish = (value: T): T => {
      const failure = context.failure;
      clear();
      if (failure) throw failure;
      return value;
    };
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        return Promise.resolve(result).then(finish, (error) => {
          clear();
          throw error;
        });
      }
      return finish(result as T);
    } catch (error) {
      clear();
      throw error;
    }
  });
}

export function currentTelemetryQuerySignal(): AbortSignal | undefined {
  return queryContext.getStore()?.signal;
}

/** Prevent an inner response cache from publishing a legacy repository's fallback data. */
export function throwIfTelemetryQueryFailed(): void {
  const failure = queryContext.getStore()?.failure;
  if (failure) throw failure;
}

/**
 * Call at the adapter's awaited rejection boundary, within the querying request.
 * Worker callbacks can run in a different request's async scope, so constructing
 * an error must never record it automatically.
 */
export function recordTelemetryQueryError(error: unknown): void {
  const context = queryContext.getStore();
  if (context?.active && error instanceof TelemetryQueryError) context.failure ??= error;
}

/** Resource failures are explicit so HTTP callers can distinguish them from query bugs. */
export class TelemetryQueryError extends Error {
  constructor(
    public readonly code: "RESULT_LIMIT" | "OVERLOADED" | "TIMEOUT" | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "TelemetryQueryError";
  }
}
