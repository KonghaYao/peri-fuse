/** Minimal TanStack Query projection needed by Gateway async-state views. */
export interface GatewayQuerySnapshot<T> {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  isFetching: boolean;
}

/** Rendering state shared by independently loaded Gateway query sections. */
export type GatewayQueryState<T> =
  | { kind: "loading"; isFetching: boolean }
  | { kind: "error"; error: unknown; isFetching: boolean }
  | {
      kind: "content";
      data: T;
      isEmpty: boolean;
      staleError: unknown | null;
      isFetching: boolean;
    };

/** Resolve the async state exposed by the shared Gateway query UI seam. */
export function resolveGatewayQueryState<T>(
  snapshot: GatewayQuerySnapshot<T>,
  isEmpty: (data: T) => boolean,
): GatewayQueryState<T> {
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
