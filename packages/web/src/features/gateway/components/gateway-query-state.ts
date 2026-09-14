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

function hasError(error: unknown): boolean {
  return error !== null && error !== undefined;
}

/** Resolve the async state exposed by the shared Gateway query UI seam. */
export function resolveGatewayQueryState<T>(
  snapshot: GatewayQuerySnapshot<T>,
  isEmpty: (data: T) => boolean,
): GatewayQueryState<T> {
  if (snapshot.data === undefined) {
    if (hasError(snapshot.error)) {
      return { kind: "error", error: snapshot.error, isFetching: snapshot.isFetching };
    }
    return { kind: "loading", isFetching: snapshot.isFetching };
  }

  return {
    kind: "content",
    data: snapshot.data,
    isEmpty: isEmpty(snapshot.data),
    staleError: hasError(snapshot.error) ? snapshot.error : null,
    isFetching: snapshot.isFetching,
  };
}
