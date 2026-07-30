/**
 * useTableState — syncs table pagination, sorting, and filters with the URL.
 *
 * Benefits: refresh-safe state, shareable links, correct back/forward
 * navigation. Replaces the repetitive useState logic each list page had.
 *
 * URL encoding:
 *   ?page=2&sort=timestamp.desc&name=chat&userId=u1
 *
 * Filters are stored as-is (string values); the page decides which keys are
 * valid via the `filterKeys` option so unrelated params are ignored.
 */

import type { SortingState } from "@tanstack/react-table";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

export interface TableStateOptions {
  /** Filter keys this table cares about (others in the URL are preserved but ignored). */
  filterKeys: string[];
  /** Default sort when none is in the URL, e.g. "timestamp.desc". */
  defaultSort?: string;
}

export interface TableState<TFilters extends Record<string, string | undefined>> {
  page: number;
  setPage: (page: number) => void;
  /** orderBy string for the API, e.g. "timestamp.desc". */
  orderBy: string;
  sorting: SortingState;
  setSorting: (sorting: SortingState) => void;
  filters: TFilters;
  setFilter: (key: keyof TFilters & string, value: string | undefined) => void;
  setFilters: (next: Partial<TFilters>) => void;
  clearFilters: () => void;
  /** Number of active (non-empty) filters. */
  activeFilterCount: number;
}

function parseSort(
  sort: string | null,
  fallback: string,
): { orderBy: string; sorting: SortingState } {
  const raw = sort ?? fallback;
  const dotIdx = raw.lastIndexOf(".");
  if (dotIdx === -1) return { orderBy: fallback, sorting: toSortingState(fallback) };
  const id = raw.slice(0, dotIdx);
  const desc = raw.slice(dotIdx + 1) === "desc";
  return { orderBy: `${id}.${desc ? "desc" : "asc"}`, sorting: [{ id, desc }] };
}

function toSortingState(orderBy: string): SortingState {
  const dotIdx = orderBy.lastIndexOf(".");
  if (dotIdx === -1) return [{ id: orderBy, desc: true }];
  return [{ id: orderBy.slice(0, dotIdx), desc: orderBy.slice(dotIdx + 1) === "desc" }];
}

export function useTableState<TFilters extends Record<string, string | undefined>>({
  filterKeys,
  defaultSort = "timestamp.desc",
}: TableStateOptions): TableState<TFilters> {
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const { orderBy, sorting } = useMemo(
    () => parseSort(searchParams.get("sort"), defaultSort),
    [searchParams, defaultSort],
  );

  const filters = useMemo(() => {
    const f: Record<string, string | undefined> = {};
    for (const key of filterKeys) {
      const value = searchParams.get(key);
      f[key] = value ?? undefined;
    }
    return f as TFilters;
  }, [searchParams, filterKeys]);

  const activeFilterCount = useMemo(
    () => filterKeys.filter((key) => searchParams.get(key)).length,
    [searchParams, filterKeys],
  );

  /** Update params, merging with existing (preserves unrelated params). */
  const updateParams = useCallback(
    (updates: Record<string, string | null>, resetPage = true) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(updates)) {
            if (value === null || value === "") {
              next.delete(key);
            } else {
              next.set(key, value);
            }
          }
          if (resetPage) {
            next.delete("page");
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setPage = useCallback(
    (p: number) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (p <= 1) {
            next.delete("page");
          } else {
            next.set("page", String(p));
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setSorting = useCallback(
    (next: SortingState) => {
      const sort =
        next.length > 0 && next[0] ? `${next[0].id}.${next[0].desc ? "desc" : "asc"}` : null;
      updateParams({ sort: sort === defaultSort ? null : sort });
    },
    [updateParams, defaultSort],
  );

  const setFilter = useCallback(
    (key: string, value: string | undefined) => {
      updateParams({ [key]: value ?? null });
    },
    [updateParams],
  );

  const setFilters = useCallback(
    (next: Partial<TFilters>) => {
      const updates: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(next)) {
        updates[key] = (value as string | undefined) ?? null;
      }
      updateParams(updates);
    },
    [updateParams],
  );

  const clearFilters = useCallback(() => {
    const updates: Record<string, string | null> = {};
    for (const key of filterKeys) {
      updates[key] = null;
    }
    updateParams(updates);
  }, [updateParams, filterKeys]);

  return {
    page,
    setPage,
    orderBy,
    sorting,
    setSorting,
    filters,
    setFilter,
    setFilters,
    clearFilters,
    activeFilterCount,
  };
}
