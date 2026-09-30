import { Search, X } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AutoRefreshControl } from "@/shared/components/auto-refresh-control";
import { DateFilterInput } from "@/shared/components/date-filter-input";
import { FilterInput, type FilterInputHandle } from "@/shared/components/filter-input";
import { FilterSelect } from "@/shared/components/filter-select";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import type { TableState } from "@/shared/hooks/use-table-state";

export type ObservabilityFilterField = {
  key: string;
  label: string;
  title?: string;
  inputType?: "number";
  defaultValue?: string;
  allLabel?: string;
  options?: { value: string; label: string }[];
  boundary?: "start" | "end";
};

function NumberFilterInput({
  field,
  value,
  onCommit,
  ref,
}: {
  field: ObservabilityFilterField;
  value: string | undefined;
  onCommit: (value: string | undefined) => void;
  ref: Ref<FilterInputHandle>;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  useImperativeHandle(
    ref,
    () => ({
      getValue: () => draft || undefined,
      reset: () => setDraft(""),
      commit: () => onCommit(draft || undefined),
    }),
    [draft, onCommit],
  );
  return (
    <div className="relative w-44">
      <Input
        type="number"
        step="any"
        title={field.title ?? field.label}
        aria-label={field.label}
        placeholder={`Filter by ${field.label}…`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(value ?? "");
        }}
        className="pr-8"
      />
      {draft && (
        <button
          type="button"
          aria-label={`Clear ${field.label}`}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-tertiary"
          onClick={() => {
            setDraft("");
            onCommit(undefined);
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function ObservabilityFilterBar<TFilters extends Record<string, string | undefined>>({
  fields,
  tableState,
}: {
  fields: ObservabilityFilterField[];
  tableState: TableState<TFilters>;
}) {
  const inputs = useRef(new Map<string, FilterInputHandle>());
  const submit = () => {
    const drafts: Record<string, string | undefined> = {};
    for (const [key, input] of inputs.current) drafts[key] = input.getValue();
    tableState.setFilters(drafts as Partial<TFilters>);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          event.stopPropagation();
          submit();
        }
      }}
    >
      {fields.map((field) => {
        const value = tableState.filters[field.key];
        if (field.options) {
          return (
            <FilterSelect
              key={field.key}
              title={field.title ?? field.label}
              allLabel={field.allLabel ?? `All ${field.label.toLowerCase()}`}
              options={field.options}
              value={value ?? field.defaultValue}
              onCommit={(next) => tableState.setFilter(field.key, next)}
            />
          );
        }
        if (field.inputType === "number") {
          return (
            <NumberFilterInput
              key={field.key}
              field={field}
              value={value}
              onCommit={(next) => tableState.setFilter(field.key, next)}
              ref={(input) => {
                if (input) inputs.current.set(field.key, input);
                else inputs.current.delete(field.key);
              }}
            />
          );
        }
        if (field.boundary) {
          return (
            <DateFilterInput
              key={field.key}
              className="w-44"
              title={field.label}
              placeholder={field.label}
              boundary={field.boundary}
              value={value}
              onCommit={(next) => tableState.setFilter(field.key, next)}
            />
          );
        }
        return (
          <FilterInput
            key={field.key}
            ref={(input) => {
              if (input) inputs.current.set(field.key, input);
              else inputs.current.delete(field.key);
            }}
            className="w-44"
            title={field.title ?? field.label}
            placeholder={`Filter by ${field.label}…`}
            value={value}
            onCommit={(next) => tableState.setFilter(field.key, next)}
          />
        );
      })}
      <Button size="sm" variant="secondary" onClick={submit}>
        <Search className="h-4 w-4" />
        Search
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          for (const input of inputs.current.values()) input.reset();
          tableState.clearFilters();
        }}
      >
        Clear ({tableState.activeFilterCount})
      </Button>
      <div className="ml-auto">
        <AutoRefreshControl />
      </div>
    </div>
  );
}
