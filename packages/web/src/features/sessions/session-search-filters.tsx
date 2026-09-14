import { AlertCircle, Clock, Search } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { DialogDescription, DialogTitle } from "@/shared/components/ui/dialog";
import type { SessionSearchTimeRange } from "@/shared/lib/types";

type SearchState = "idle" | "loading" | "error";

type SessionSearchFiltersProps = {
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

export function SessionSearchFilters({
  query,
  onQueryChange,
  range,
  onRangeChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  searchState,
  error,
  onSubmit,
  onCancel,
}: SessionSearchFiltersProps) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border p-4">
      <div className="flex items-center gap-2">
        <DialogTitle className="text-base">Search sessions</DialogTitle>
        <DialogDescription id="session-search-description" className="sr-only">
          Search user and AI message text, then select a result to preview its context.
        </DialogDescription>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2 top-2 h-4 w-4 text-fg-tertiary" />
          <input
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search user or AI message text…"
            className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring/30"
            aria-label="Search message text"
          />
        </div>
        <select
          aria-label="Time range"
          value={range.kind === "relative" ? String(range.seconds) : "custom"}
          onChange={(event) =>
            event.target.value === "custom"
              ? onRangeChange({
                  kind: "absolute",
                  fromTimestamp: customFrom,
                  toTimestamp: customTo,
                })
              : onRangeChange({
                  kind: "relative",
                  seconds: Number(event.target.value) as 3600 | 21600 | 86400 | 604800,
                })
          }
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="3600">Last 1 hour</option>
          <option value="21600">Last 6 hours</option>
          <option value="86400">Last 24 hours</option>
          <option value="604800">Last 7 days</option>
          <option value="custom">Custom range</option>
        </select>
        <Button size="sm" onClick={onSubmit} disabled={searchState === "loading"}>
          <Search />
          Search
        </Button>
        {searchState === "loading" && (
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {range.kind === "absolute" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Clock className="h-3.5 w-3.5 text-fg-tertiary" />
          <label>
            From{" "}
            <input
              type="datetime-local"
              // Keep this native segmented control uncontrolled while editing. Browsers expose an
              // empty value for incomplete segments; feeding that value back on every change resets
              // the segment the user is currently entering.
              defaultValue={customFrom}
              onChange={(event) => onCustomFromChange(event.target.value)}
              className="h-7 rounded border border-border bg-background px-2"
            />
          </label>
          <label>
            To{" "}
            <input
              type="datetime-local"
              defaultValue={customTo}
              onChange={(event) => onCustomToChange(event.target.value)}
              className="h-7 rounded border border-border bg-background px-2"
            />
          </label>
        </div>
      )}
      {searchState === "error" && (
        <p className="flex items-center gap-1 text-xs text-danger">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
