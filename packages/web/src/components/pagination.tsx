import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { PaginationMeta } from "@/lib/types";

/**
 * Simple prev/next pagination footer driven by the API's pagination meta.
 * Pages are 1-based, matching the lite-server public API contract.
 */
export function Pagination({
  meta,
  page,
  onPageChange,
}: {
  meta: PaginationMeta | undefined;
  page: number;
  onPageChange: (page: number) => void;
}) {
  if (!meta) return null;
  const { totalItems, totalPages } = meta;

  return (
    <div className="flex items-center justify-between px-2 py-1">
      <p className="text-xs text-muted-foreground">
        {totalItems} item{totalItems === 1 ? "" : "s"}
        {totalPages > 1 ? ` · page ${page} of ${totalPages}` : ""}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          <ChevronLeft className="h-4 w-4" />
          Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
