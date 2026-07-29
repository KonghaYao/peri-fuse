import { AlertCircle, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";

/** Page-level title block. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Skeleton block for loading tables/cards. */
export function LoadingRows({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * Unified error banner. 401s point the user back to the settings page since
 * that is almost always a credentials problem in the lite setup.
 */
export function ErrorState({ error }: { error: unknown }) {
  const isUnauthorized = error instanceof ApiError && error.status === 401;
  return (
    <div className="m-4 flex items-start gap-3 rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
      <div className="space-y-1">
        <p className="font-medium text-red-500">
          {isUnauthorized ? "Unauthorized" : "Request failed"}
        </p>
        <p className="text-muted-foreground">
          {error instanceof Error ? error.message : String(error)}
        </p>
        {isUnauthorized && (
          <Link to="/settings" className="inline-block text-red-400 underline">
            Check your API keys in Settings
          </Link>
        )}
      </div>
    </div>
  );
}

/** Empty-state placeholder for lists without rows. */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
      <Inbox className="h-8 w-8" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
