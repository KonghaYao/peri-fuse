import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/shared/components/ui/button";
import { resolveUsageQueryState, type UsageQuerySnapshot } from "./usage-query-state";

/** Query surface consumed by the shared Gateway Usage async-state boundary. */
export interface UsageQueryHandle<T> extends UsageQuerySnapshot<T> {
  refetch: () => Promise<unknown>;
}

function QueryFailure({
  label,
  error,
  isFetching,
  isStale,
  onRetry,
}: {
  label: string;
  error: unknown;
  isFetching: boolean;
  isStale: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="mb-3 flex flex-wrap items-start gap-3 rounded-md border border-danger/30 bg-danger-subtle p-3 text-sm"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-danger">
          {isStale
            ? `Could not refresh ${label}; showing previous data.`
            : `Could not load ${label}.`}
        </p>
        <p className="break-words text-fg-secondary">
          {error instanceof Error ? error.message : String(error)}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isFetching}
        onClick={onRetry}
        aria-label={`Retry ${label}`}
      >
        {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {isFetching ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}

/**
 * Owns the complete async-state boundary shared by Gateway Usage sections while
 * delegating their successful and empty content layouts to the page.
 */
export function UsageQuerySection<T>({
  label,
  query,
  isEmpty,
  loading,
  empty,
  children,
}: {
  label: string;
  query: UsageQueryHandle<T>;
  isEmpty: (data: T) => boolean;
  loading: ReactNode;
  empty: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const state = resolveUsageQueryState(query, isEmpty);
  const retry = () => void query.refetch();

  if (state.kind === "loading") {
    return (
      <div role="status" aria-live="polite" aria-label={`Loading ${label}`}>
        {loading}
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <QueryFailure
        label={label}
        error={state.error}
        isFetching={state.isFetching}
        isStale={false}
        onRetry={retry}
      />
    );
  }

  return (
    <div aria-busy={state.isFetching}>
      {state.staleError !== null && (
        <QueryFailure
          label={label}
          error={state.staleError}
          isFetching={state.isFetching}
          isStale
          onRetry={retry}
        />
      )}
      {state.isFetching && !state.staleError && (
        <span role="status" className="sr-only">
          Refreshing {label}
        </span>
      )}
      {state.isEmpty ? empty : children(state.data)}
    </div>
  );
}
