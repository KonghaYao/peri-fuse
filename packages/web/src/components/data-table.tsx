/**
 * Lightweight DataTable shell for lite-web, built on @tanstack/react-table
 * (headless). Provides the table chrome the original web DataTable offers —
 * sortable headers, column visibility dropdown, pagination, loading/empty/
 * error states — without the web's pinned columns, virtualization, peek
 * views, or tRPC coupling.
 *
 * Sorting and pagination are server-driven (manual): the parent page owns
 * the sorting state and maps it to the API's orderBy parameter.
 */

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  type RowData,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Settings2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Pagination } from "@/components/pagination";
import { EmptyState, ErrorState } from "@/components/state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PaginationMeta } from "@/lib/types";
import { cn } from "@/lib/utils";

declare module "@tanstack/react-table" {
  // Column-def extension mirroring web's LangfuseColumnDef.defaultHidden:
  // columns with meta.defaultHidden start hidden (togglable in the dropdown).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    defaultHidden?: boolean;
  }
}

interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  isLoading?: boolean;
  error?: unknown;
  emptyMessage?: string;
  /** Server pagination meta (1-based pages). */
  meta?: PaginationMeta;
  page?: number;
  onPageChange?: (page: number) => void;
  onRowClick?: (row: TData) => void;
  /** Server-side sorting state + change handler. */
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /** Extra controls (filters etc.) rendered left of the columns button. */
  toolbar?: ReactNode;
  getRowId?: (row: TData) => string;
}

function columnLabel(column: { columnDef: ColumnDef<unknown, unknown>; id: string }): string {
  const header = column.columnDef.header;
  return typeof header === "string" ? header : column.id;
}

/** Derive initial column visibility from `meta.defaultHidden` definitions. */
function initialVisibility<TData>(columns: ColumnDef<TData, unknown>[]): VisibilityState {
  const vis: VisibilityState = {};
  const walk = (cols: ColumnDef<TData, unknown>[]) => {
    for (const col of cols) {
      const group = col as { columns?: ColumnDef<TData, unknown>[] };
      if (group.columns) walk(group.columns);
      if (col.id && col.meta?.defaultHidden) vis[col.id] = false;
    }
  };
  walk(columns);
  return vis;
}

export function DataTable<TData>({
  columns,
  data,
  isLoading,
  error,
  emptyMessage = "No data",
  meta,
  page = 1,
  onPageChange,
  onRowClick,
  sorting = [],
  onSortingChange,
  toolbar,
  getRowId,
}: DataTableProps<TData>) {
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() =>
    initialVisibility(columns),
  );

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnVisibility,
    },
    onSortingChange: (updaterOrValue) => {
      const next = typeof updaterOrValue === "function" ? updaterOrValue(sorting) : updaterOrValue;
      onSortingChange?.(next);
    },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    // Pin the first sort direction to ascending. Without this, tanstack derives
    // it from the first row's value (getAutoSortDir), which is data-dependent and
    // flips once a column with leading NULLs is sorted (SQLite orders NULLs first),
    // breaking the asc -> desc -> clear cycle.
    sortDescFirst: false,
    ...(getRowId ? { getRowId } : {}),
  });

  const visibleColumns = table.getVisibleLeafColumns();
  const colSpan = Math.max(visibleColumns.length, 1);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-2">
        {toolbar}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto h-8">
              <Settings2 className="h-4 w-4" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[400px] w-[200px] overflow-auto">
            <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table
              .getAllLeafColumns()
              .filter((column) => column.getCanHide())
              .map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="text-xs"
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {columnLabel(
                    column as {
                      columnDef: ColumnDef<unknown, unknown>;
                      id: string;
                    },
                  )}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="bg-muted/30 hover:bg-muted/30">
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id} className="whitespace-nowrap text-xs">
                      {header.isPlaceholder ? null : (
                        <div
                          className={cn(
                            "flex select-none items-center gap-1",
                            canSort && "cursor-pointer",
                          )}
                          onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {canSort &&
                            (sorted === "asc" ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : sorted === "desc" ? (
                              <ArrowDown className="h-3 w-3" />
                            ) : (
                              <ChevronsUpDown className="h-3 w-3 opacity-40" />
                            ))}
                        </div>
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {visibleColumns.map((column) => (
                    <TableCell key={column.id}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : error ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="p-0">
                  <ErrorState error={error} />
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan}>
                  <EmptyState message={emptyMessage} />
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={cn(onRowClick && "cursor-pointer")}
                  onClick={() => onRowClick?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="max-w-[320px]">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {onPageChange && <Pagination meta={meta} page={page} onPageChange={onPageChange} />}
    </div>
  );
}
