import { AlertTriangle, ChevronRight, Clock3, Globe, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { FilterInput, type FilterInputHandle } from "@/shared/components/filter-input";
import { FilterSelect } from "@/shared/components/filter-select";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/shared/components/state";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { useErrorsQuery } from "@/shared/hooks/queries";
import { formatDateTime, formatDuration } from "@/shared/lib/format";
import type { ErrorEvent, ErrorQueryParams } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";
import { ErrorAnalysisRail } from "./components/error-analysis-rail";
import { ErrorInvestigationPanel } from "./components/error-investigation-panel";

const RANGE_MS: Record<string, number | null> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
  all: null,
};

function ErrorRow({
  error,
  selected,
  onSelect,
}: {
  error: ErrorEvent;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group grid w-full grid-cols-[18px_minmax(0,1fr)_auto] gap-3 border-b border-line px-4 py-3 text-left transition-colors focus-visible:bg-danger-subtle",
        selected ? "bg-danger-subtle" : "hover:bg-surface-inset/70",
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 text-danger" />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-fg-primary">
            {error.name ?? "Unnamed observation"}
          </span>
          <Badge variant="muted" className="shrink-0 font-mono text-[9px]">
            {error.type}
          </Badge>
          {error.model && (
            <span className="hidden truncate font-mono text-[10px] text-fg-tertiary sm:block">
              {error.model}
            </span>
          )}
        </div>
        <p className="mt-1 line-clamp-2 font-mono text-[11px] leading-4 text-fg-secondary">
          {error.statusMessage ?? "No status message recorded"}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-fg-tertiary">
          <span>{error.traceName ?? error.traceId ?? "Unknown trace"}</span>
          {error.environment && <span>{error.environment}</span>}
          {error.endTime && <span>{formatDuration(error.startTime, error.endTime)}</span>}
        </div>
      </div>
      <div className="flex items-start gap-2">
        <time className="hidden whitespace-nowrap font-mono text-[10px] text-fg-tertiary sm:block">
          {formatDateTime(error.startTime)}
        </time>
        <ChevronRight className="h-4 w-4 text-fg-tertiary transition-transform group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}

export function ErrorsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [clock] = useState(() => Date.now());
  const searchRef = useRef<FilterInputHandle>(null);
  const environmentRef = useRef<FilterInputHandle>(null);
  const range = searchParams.get("range") ?? "7d";
  const search = searchParams.get("search") ?? undefined;
  const type = searchParams.get("type") ?? undefined;
  const model = searchParams.get("model") ?? undefined;
  const environment = searchParams.get("environment") ?? undefined;
  const selectedId = searchParams.get("errorId") ?? undefined;

  const params = useMemo<ErrorQueryParams>(() => {
    const duration = RANGE_MS[range] ?? RANGE_MS["7d"];
    return {
      from: duration === null ? undefined : new Date(clock - duration).toISOString(),
      search,
      type,
      model,
      environment,
    };
  }, [clock, environment, model, range, search, type]);
  const query = useErrorsQuery(params);
  const analysis = query.data?.pages[0];
  const errors = query.data?.pages.flatMap((page) => page.data) ?? [];
  const selected = errors.find((error) => error.id === selectedId);

  const updateFilter = (key: string, value: string | undefined) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      next.delete("errorId");
      return next;
    });
  };

  const selectError = (id: string | undefined) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set("errorId", id);
        else next.delete("errorId");
        return next;
      },
      { replace: true },
    );
  };

  const clearFilters = () => {
    setSearchParams({ range });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Errors"
        description="Find recurring failures and follow their evidence back to the source."
        actions={<AutoRefreshControl />}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="flex rounded-md border border-line bg-surface-inset p-0.5">
          {Object.keys(RANGE_MS).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => updateFilter("range", item)}
              className={cn(
                "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                range === item
                  ? "bg-surface-raised text-fg-primary shadow-sm"
                  : "text-fg-tertiary hover:text-fg-primary",
              )}
            >
              {item === "all" ? "All" : item}
            </button>
          ))}
        </div>
        <FilterInput
          ref={searchRef}
          className="w-64"
          placeholder="Search message, trace or name…"
          icon={Search}
          value={search}
          onCommit={(value) => updateFilter("search", value)}
        />
        <FilterInput
          ref={environmentRef}
          className="w-40"
          placeholder="Environment…"
          icon={Globe}
          value={environment}
          onCommit={(value) => updateFilter("environment", value)}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            searchRef.current?.commit();
            environmentRef.current?.commit();
          }}
        >
          <Search className="h-3.5 w-3.5" /> Search
        </Button>
        <FilterSelect
          placeholder="Type"
          allLabel="All types"
          value={type}
          onCommit={(value) => updateFilter("type", value)}
          options={["GENERATION", "SPAN", "EVENT", "AGENT", "TOOL"].map((value) => ({
            value,
            label: value,
          }))}
        />
        <FilterSelect
          placeholder="Model"
          allLabel="All models"
          value={model}
          onCommit={(value) => updateFilter("model", value)}
          options={(analysis?.models ?? []).map((item) => ({
            value: item.model,
            label: `${item.model} (${item.count})`,
          }))}
        />
        {(search || type || model || environment) && (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            <X className="h-3.5 w-3.5" /> Clear filters
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {analysis && (
          <aside className="hidden w-72 shrink-0 overflow-y-auto border-r border-line bg-surface-raised lg:block">
            <ErrorAnalysisRail
              analysis={analysis}
              onSelectSignature={(signature) => updateFilter("search", signature)}
            />
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {analysis && (
            <details className="shrink-0 border-b border-line bg-surface-raised lg:hidden">
              <summary className="cursor-pointer px-4 py-2.5 text-xs font-semibold text-fg-secondary">
                Analysis snapshot · {analysis.summary.uniqueSignatures} fingerprints
              </summary>
              <ErrorAnalysisRail
                analysis={analysis}
                onSelectSignature={(signature) => updateFilter("search", signature)}
              />
            </details>
          )}
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-4">
            <div className="flex items-center gap-2 text-xs text-fg-secondary">
              <Clock3 className="h-3.5 w-3.5" />
              <span>
                {analysis
                  ? `${analysis.summary.totalErrors.toLocaleString()} matching errors`
                  : "Loading errors"}
              </span>
            </div>
            <span className="font-mono text-[10px] text-fg-tertiary">Newest first</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {query.isLoading ? (
              <LoadingRows rows={10} />
            ) : query.error ? (
              <ErrorState error={query.error} />
            ) : errors.length === 0 ? (
              <EmptyState message="No errors match this investigation window." />
            ) : (
              <>
                {errors.map((error) => (
                  <ErrorRow
                    key={error.id}
                    error={error}
                    selected={error.id === selectedId}
                    onSelect={() => selectError(error.id)}
                  />
                ))}
                {query.hasNextPage && (
                  <div className="flex justify-center p-4">
                    <Button
                      variant="secondary"
                      disabled={query.isFetchingNextPage}
                      onClick={() => query.fetchNextPage()}
                    >
                      {query.isFetchingNextPage ? "Loading…" : "Load older errors"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </main>

        {selected && (
          <ErrorInvestigationPanel error={selected} onClose={() => selectError(undefined)} />
        )}
      </div>
    </div>
  );
}
