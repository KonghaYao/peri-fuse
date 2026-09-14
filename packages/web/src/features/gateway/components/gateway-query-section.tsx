import { Button } from "@peri/ui";
import { Loader2 } from "lucide-solid";
import { type Component, createMemo, type JSX, Match, Switch } from "solid-js";
import {
  type GatewayQuerySnapshot,
  type GatewayQueryState,
  resolveGatewayQueryState,
} from "./gateway-query-state";

/** Query surface consumed by the shared Gateway async-state seam. */
export interface GatewayQueryHandle<T> extends GatewayQuerySnapshot<T> {
  refetch: () => Promise<unknown>;
}

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const QueryFailure: Component<{
  label: string;
  error: unknown;
  isFetching: boolean;
  isStale: boolean;
  onRetry: () => void;
}> = (props) => (
  <div
    role="alert"
    class="mb-3 flex flex-wrap items-start gap-3 rounded-md border border-danger/30 bg-danger-subtle p-3 text-sm"
  >
    <div class="min-w-0 flex-1">
      <p class="font-medium text-danger">
        {props.isStale
          ? `Could not refresh ${props.label}; showing previous data.`
          : `Could not load ${props.label}.`}
      </p>
      <p class="break-words text-fg-secondary">{resolveErrorMessage(props.error)}</p>
    </div>
    <Button
      type="button"
      size="sm"
      variant="default"
      disabled={props.isFetching}
      onClick={props.onRetry}
      aria-label={`Retry ${props.label}`}
    >
      {props.isFetching ? <Loader2 class="h-3.5 w-3.5 animate-spin" size={14} /> : null}
      {props.isFetching ? "Retrying…" : "Retry"}
    </Button>
  </div>
);

export function GatewayQuerySection<T>(props: {
  label: string;
  query: GatewayQueryHandle<T>;
  isEmpty: (data: T) => boolean;
  loading: JSX.Element;
  empty: JSX.Element;
  children: (data: T) => JSX.Element;
}) {
  const state = createMemo(() => resolveGatewayQueryState(props.query, props.isEmpty));
  const contentState = createMemo(() => {
    const current = state();
    return current.kind === "content" ? current : undefined;
  });
  const retry = () => void props.query.refetch();

  return (
    <Switch>
      <Match when={state().kind === "loading"}>
        <div role="status" aria-live="polite" aria-label={`Loading ${props.label}`}>
          {props.loading}
        </div>
      </Match>
      <Match when={state().kind === "error"}>
        <QueryFailure
          label={props.label}
          error={(state() as GatewayQueryState<T> & { kind: "error" }).error}
          isFetching={props.query.isFetching}
          isStale={false}
          onRetry={retry}
        />
      </Match>
      <Match when={contentState()}>
        {(s) => {
          const content = s() as GatewayQueryState<T> & {
            kind: "content";
            data: T;
            isEmpty: boolean;
            staleError: unknown | null;
            isFetching: boolean;
          };
          return (
            <div aria-busy={content.isFetching}>
              {content.staleError !== null && (
                <QueryFailure
                  label={props.label}
                  error={content.staleError}
                  isFetching={props.query.isFetching}
                  isStale
                  onRetry={retry}
                />
              )}
              {content.isFetching && !content.staleError && (
                <span role="status" class="sr-only">
                  Refreshing {props.label}
                </span>
              )}
              {content.isEmpty ? props.empty : props.children(content.data)}
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}
