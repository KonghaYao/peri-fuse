import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";

export interface FilterField {
  name: string;
  label: string;
  type?: "date" | "number";
  options?: string[];
}

export function useGatewayFilters(prefix: string, defaults?: Record<string, string>) {
  const [search, setSearch] = useSearchParams();
  const defaultValues = defaults ? JSON.stringify(defaults) : "";
  const needsDefaultDates =
    Boolean(defaults) &&
    search.get(`${prefix}.range`) !== "all" &&
    !search.has(`${prefix}.startDate`) &&
    !search.has(`${prefix}.endDate`);
  useEffect(() => {
    if (!defaultValues || !needsDefaultDates) return;
    setSearch(
      (current) => {
        if (
          current.get(`${prefix}.range`) === "all" ||
          current.has(`${prefix}.startDate`) ||
          current.has(`${prefix}.endDate`)
        )
          return current;
        const next = new URLSearchParams(current);
        const initial: Record<string, string> = JSON.parse(defaultValues);
        for (const [name, value] of Object.entries(initial)) next.set(`${prefix}.${name}`, value);
        next.set(`${prefix}.range`, "custom");
        return next;
      },
      { replace: true },
    );
  }, [defaultValues, needsDefaultDates, prefix, setSearch]);
  const values: Record<string, string> = {};
  if (needsDefaultDates && defaults) Object.assign(values, defaults);
  for (const [key, value] of search) {
    if (key.startsWith(`${prefix}.`) && key !== `${prefix}.range`)
      values[key.slice(prefix.length + 1)] = value;
  }
  const rawOffset = Number(values.offset ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  function set(name: string, value: string) {
    setSearch((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(`${prefix}.${name}`, value);
      else next.delete(`${prefix}.${name}`);
      if (name !== "offset") next.delete(`${prefix}.offset`);
      if (defaults)
        next.set(
          `${prefix}.range`,
          next.has(`${prefix}.startDate`) || next.has(`${prefix}.endDate`) ? "custom" : "all",
        );
      return next;
    });
  }
  function clear() {
    setSearch((current) => {
      const next = new URLSearchParams(current);
      for (const key of [...next.keys()]) {
        if (key.startsWith(`${prefix}.`)) next.delete(key);
      }
      if (defaults) next.set(`${prefix}.range`, "all");
      return next;
    });
  }
  function apply(fields: FilterField[], draft: Record<string, string>) {
    setSearch((current) => {
      const next = new URLSearchParams(current);
      for (const field of fields) {
        const value = draft[field.name];
        if (value) next.set(`${prefix}.${field.name}`, value);
        else next.delete(`${prefix}.${field.name}`);
      }
      next.delete(`${prefix}.offset`);
      if (defaults)
        next.set(
          `${prefix}.range`,
          next.has(`${prefix}.startDate`) || next.has(`${prefix}.endDate`) ? "custom" : "all",
        );
      return next;
    });
  }
  return { values, offset, set, clear, apply };
}

export function GatewayFilters({
  fields,
  filters,
}: {
  fields: FilterField[];
  filters: ReturnType<typeof useGatewayFilters>;
}) {
  const serialized = JSON.stringify(filters.values);
  const [draft, setDraft] = useState<Record<string, string>>(filters.values);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(JSON.parse(serialized));
    setError("");
  }, [serialized]);
  return (
    <form
      noValidate
      className="mb-4 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const invalid = fields.find(
          (field) => field.type === "number" && !isValidDuration(draft[field.name]),
        );
        if (invalid) {
          setError(`${invalid.label} must be a non-negative safe integer`);
          return;
        }
        setError("");
        filters.apply(fields, draft);
      }}
    >
      {fields.map((field) => (
        <label key={field.name} className="text-xs text-fg-secondary">
          <span className="mb-1 block">{field.label}</span>
          {field.options ? (
            <select
              aria-label={field.label}
              className="h-9 rounded-md border border-border bg-surface-raised px-3"
              value={draft[field.name] ?? ""}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [field.name]: event.target.value }))
              }
            >
              <option value="">All</option>
              {field.options.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ) : (
            <Input
              aria-label={field.label}
              title={
                field.label.includes("exact")
                  ? "Exact match; partial names are not matched"
                  : field.label
              }
              className="w-44"
              type={field.type === "date" ? "date" : "text"}
              inputMode={field.type === "number" ? "numeric" : undefined}
              value={draft[field.name] ?? ""}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [field.name]: event.target.value }))
              }
            />
          )}
        </label>
      ))}
      <Button type="submit" size="sm">
        Apply filters
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setDraft({});
          setError("");
          filters.clear();
        }}
      >
        Clear filters
      </Button>
      {error && (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

export function isValidDuration(value: string | undefined): boolean {
  return !value || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)));
}

export function logDateFilters(values: Record<string, string>) {
  const result: { startDate?: string; endDate?: string } = {};
  for (const name of ["startDate", "endDate"] as const) {
    const value = values[name];
    if (!value) continue;
    const suffix = name === "startDate" ? "T00:00:00.000Z" : "T23:59:59.999Z";
    result[name] = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}${suffix}` : value;
  }
  return result;
}

export function GatewayPagination({
  filters,
  total,
  pageSize,
  disabled = false,
}: {
  filters: ReturnType<typeof useGatewayFilters>;
  total: number;
  pageSize: number;
  disabled?: boolean;
}) {
  return (
    <div className="mt-4 flex items-center justify-center gap-3 text-xs">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || filters.offset === 0}
        onClick={() => filters.set("offset", String(Math.max(0, filters.offset - pageSize)))}
      >
        Previous
      </Button>
      <span>{total} results</span>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || filters.offset + pageSize >= total}
        onClick={() => filters.set("offset", String(filters.offset + pageSize))}
      >
        Next
      </Button>
    </div>
  );
}
