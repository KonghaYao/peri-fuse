import { AlertCircle, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { ApiError } from "@/shared/lib/api";

/** Page-level title block — Spectra §8: fixed 60px, sticky, title + subtitle. */
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
    <div className="sticky top-0 z-10 flex h-[60px] shrink-0 items-center justify-between gap-4 border-b border-border bg-surface-base/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-surface-base/80">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="shrink-0 text-lg font-semibold tracking-[-0.02em] text-fg-primary">
          {title}
        </h1>
        {description && <p className="truncate text-sm text-fg-tertiary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
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
    <div className="m-4 flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-subtle p-4 text-sm">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="space-y-1">
        <p className="font-medium text-danger">
          {isUnauthorized ? "Unauthorized" : "Request failed"}
        </p>
        <p className="text-fg-secondary">
          {error instanceof Error ? error.message : String(error)}
        </p>
        {isUnauthorized && (
          <Link to="/settings" className="inline-block text-danger underline">
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
    <div className="flex flex-col items-center gap-2 py-16 text-fg-tertiary">
      <Inbox className="h-5 w-5" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
