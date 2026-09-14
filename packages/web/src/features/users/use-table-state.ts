/**
 * URL-synced table pagination, sorting, and filters for list pages.
 *
 * Port of the React `useTableState` hook for Solid + @solidjs/router.
 */

import type { DataTableSortState } from "@peri/ui";
import { useSearchParams } from "@solidjs/router";
import { createMemo } from "solid-js";
import { searchParamValue } from "@/features/users/search-param";

export type TableSorting = Array<{ id: string; desc: boolean }>;

export interface TableStateOptions {
  filterKeys: string[];
  defaultSort?: string;
}

export interface TableState<TFilters extends Record<string, string | undefined>> {
  page: () => number;
  setPage: (page: number) => void;
  orderBy: () => string;
  sorting: () => TableSorting;
  setSorting: (sorting: TableSorting) => void;
  filters: () => TFilters;
  setFilter: (key: keyof TFilters & string, value: string | undefined) => void;
  setFilters: (next: Partial<TFilters>) => void;
  clearFilters: () => void;
  activeFilterCount: () => number;
  dataTableSort: () => DataTableSortState;
  setDataTableSort: (sort: DataTableSortState) => void;
}

function parseSort(
  sort: string | null | undefined,
  fallback: string,
): { orderBy: string; sorting: TableSorting } {
  const raw = sort ?? fallback;
  const dotIdx = raw.lastIndexOf(".");
  if (dotIdx === -1) return { orderBy: fallback, sorting: toSortingState(fallback) };
  const id = raw.slice(0, dotIdx);
  const desc = raw.slice(dotIdx + 1) === "desc";
  return { orderBy: `${id}.${desc ? "desc" : "asc"}`, sorting: [{ id, desc }] };
}

function toSortingState(orderBy: string): TableSorting {
  const dotIdx = orderBy.lastIndexOf(".");
  if (dotIdx === -1) return [{ id: orderBy, desc: true }];
  return [{ id: orderBy.slice(0, dotIdx), desc: orderBy.slice(dotIdx + 1) === "desc" }];
}

export function sortingToDataTable(sorting: TableSorting): DataTableSortState {
  const first = sorting[0];
  if (!first) return null;
  return { columnId: first.id, direction: first.desc ? "desc" : "asc" };
}

export function dataTableToSorting(sort: DataTableSortState): TableSorting {
  if (!sort) return [];
  return [{ id: sort.columnId, desc: sort.direction === "desc" }];
}

export function useTableState<TFilters extends Record<string, string | undefined>>({
  filterKeys,
  defaultSort = "timestamp.desc",
}: TableStateOptions): TableState<TFilters> {
  const [searchParams, setSearchParams] = useSearchParams();

  const page = createMemo(() =>
    Math.max(1, Number.parseInt(searchParamValue(searchParams.page) ?? "1", 10) || 1),
  );

  const sortState = createMemo(() => parseSort(searchParamValue(searchParams.sort), defaultSort));
  const orderBy = () => sortState().orderBy;
  const sorting = () => sortState().sorting;

  const filters = createMemo(() => {
    const next: Record<string, string | undefined> = {};
    for (const key of filterKeys) {
      next[key] = searchParamValue(searchParams[key]);
    }
    return next as TFilters;
  });

  const activeFilterCount = createMemo(
    () => filterKeys.filter((key) => Boolean(searchParamValue(searchParams[key]))).length,
  );

  const mergeParams = (updates: Record<string, string | null | undefined>, resetPage = true) => {
    const merged: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(updates)) {
      merged[key] = value === null || value === undefined || value === "" ? undefined : value;
    }
    if (resetPage) merged.page = undefined;
    setSearchParams(merged, { replace: true });
  };

  const setPage = (p: number) => {
    setSearchParams({ page: p <= 1 ? undefined : String(p) }, { replace: true });
  };

  const setSorting = (next: TableSorting) => {
    const sort =
      next.length > 0 && next[0] ? `${next[0].id}.${next[0].desc ? "desc" : "asc"}` : undefined;
    mergeParams({ sort: sort === defaultSort ? null : (sort ?? null) });
  };

  const setFilter = (key: string, value: string | undefined) => {
    mergeParams({ [key]: value ?? null });
  };

  const setFilters = (next: Partial<TFilters>) => {
    const updates: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(next)) {
      updates[key] = (value as string | undefined) ?? null;
    }
    mergeParams(updates);
  };

  const clearFilters = () => {
    const updates: Record<string, string | null> = {};
    for (const key of filterKeys) updates[key] = null;
    mergeParams(updates);
  };

  const dataTableSort = createMemo(() => sortingToDataTable(sorting()));
  const setDataTableSort = (sort: DataTableSortState) => setSorting(dataTableToSorting(sort));

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
    dataTableSort,
    setDataTableSort,
  };
}
