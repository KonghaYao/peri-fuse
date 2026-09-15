import { Button, DialogDescription, DialogTitle } from "@peri/ui";
import { AlertCircle, Clock, Search } from "lucide-solid";
import type { Component } from "solid-js";
import { Show } from "solid-js";
import type { SessionSearchTimeRange } from "@/shared/lib/types";

type SearchState = "idle" | "loading" | "error";

export type SessionSearchFiltersProps = {
  query: string;
  onQueryChange: (query: string) => void;
  range: SessionSearchTimeRange;
  onRangeChange: (range: SessionSearchTimeRange) => void;
  customFrom: string;
  customTo: string;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  searchState: SearchState;
  error: string;
  onSubmit: () => void;
  onCancel: () => void;
};

export const SessionSearchFilters: Component<SessionSearchFiltersProps> = (props) => (
  <div class="flex shrink-0 flex-col gap-8 border-b border-border p-16">
    <div class="flex items-center gap-8">
      <DialogTitle class="text-base">Search sessions</DialogTitle>
      <DialogDescription id="session-search-description" class="sr-only">
        Search user and AI message text, then select a result to preview its context.
      </DialogDescription>
    </div>
    <div class="flex flex-wrap items-center gap-8">
      <div class="relative min-w-[220px] flex-1">
        <Search class="absolute left-8 top-8 h-16 w-16 text-fg-tertiary" size={16} />
        <input
          autofocus
          value={props.query}
          onInput={(event) => props.onQueryChange(event.currentTarget.value)}
          placeholder="Search user or AI message text…"
          class="h-32 w-full rounded-md border border-border bg-background pl-32 pr-12 text-sm outline-none focus:ring-2 focus:ring-ring/30"
          aria-label="Search message text"
        />
      </div>
      <select
        aria-label="Time range"
        value={props.range.kind === "relative" ? String(props.range.seconds) : "custom"}
        onChange={(event) =>
          event.currentTarget.value === "custom"
            ? props.onRangeChange({
                kind: "absolute",
                fromTimestamp: props.customFrom,
                toTimestamp: props.customTo,
              })
            : props.onRangeChange({
                kind: "relative",
                seconds: Number(event.currentTarget.value) as 3600 | 21600 | 86400 | 604800,
              })
        }
        class="h-32 rounded-md border border-border bg-background px-8 text-sm"
      >
        <option value="3600">Last 1 hour</option>
        <option value="21600">Last 6 hours</option>
        <option value="86400">Last 24 hours</option>
        <option value="604800">Last 7 days</option>
        <option value="custom">Custom range</option>
      </select>
      <Button size="sm" onClick={props.onSubmit} disabled={props.searchState === "loading"}>
        <Search size={16} />
        Search
      </Button>
      <Show when={props.searchState === "loading"}>
        <Button size="sm" variant="secondary" onClick={props.onCancel}>
          Cancel
        </Button>
      </Show>
    </div>
    <Show when={props.range.kind === "absolute"}>
      <div class="flex flex-wrap items-center gap-8 text-xs">
        <Clock class="h-14 w-14 text-fg-tertiary" size={14} />
        <label>
          From{" "}
          <input
            type="datetime-local"
            value={props.customFrom}
            onInput={(event) => props.onCustomFromChange(event.currentTarget.value)}
            class="h-28 rounded border border-border bg-background px-8"
          />
        </label>
        <label>
          To{" "}
          <input
            type="datetime-local"
            value={props.customTo}
            onInput={(event) => props.onCustomToChange(event.currentTarget.value)}
            class="h-28 rounded border border-border bg-background px-8"
          />
        </label>
      </div>
    </Show>
    <Show when={props.searchState === "error"}>
      <p class="flex items-center gap-4 text-xs text-danger">
        <AlertCircle class="h-14 w-14" size={14} />
        {props.error}
      </p>
    </Show>
  </div>
);
