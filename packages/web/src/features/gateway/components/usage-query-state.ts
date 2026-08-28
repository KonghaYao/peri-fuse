/** Minimal TanStack Query projection needed by the Gateway Usage state machine. */
export interface UsageQuerySnapshot<T> {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  isFetching: boolean;
}

/** Rendering state shared by all four independently loaded Gateway Usage sections. */
export type UsageQueryState<T> =
  | { kind: "loading"; isFetching: boolean }
  | { kind: "error"; error: unknown; isFetching: boolean }
  | {
      kind: "content";
      data: T;
      isEmpty: boolean;
      staleError: unknown | null;
      isFetching: boolean;
    };

/** Resolve the async state that Gateway Usage sections expose to their shared UI boundary. */
export function resolveUsageQueryState<T>(
  snapshot: UsageQuerySnapshot<T>,
  isEmpty: (data: T) => boolean,
): UsageQueryState<T> {
  if (snapshot.data === undefined) {
    if (snapshot.error !== null && snapshot.error !== undefined) {
      return { kind: "error", error: snapshot.error, isFetching: snapshot.isFetching };
    }
    return { kind: "loading", isFetching: snapshot.isFetching };
  }

  return {
    kind: "content",
    data: snapshot.data,
    isEmpty: isEmpty(snapshot.data),
    staleError: snapshot.error !== null && snapshot.error !== undefined ? snapshot.error : null,
    isFetching: snapshot.isFetching,
  };
}
