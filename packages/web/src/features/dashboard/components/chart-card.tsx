/**
 * Shared building blocks for the dashboard charts: a titled card wrapper with a
 * consistent empty state, plus the shared tooltip styling.
 */

import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { cn } from "@/shared/lib/utils";

export const TOOLTIP_STYLE = {
  background: "var(--popover)",
  border: "1px solid var(--line-strong)",
  borderRadius: 8,
  fontSize: 12,
} as const;

export const TOOLTIP_LABEL_STYLE = { color: "var(--fg-primary)" } as const;

export function ChartCard({
  title,
  description,
  isEmpty,
  emptyMessage = "No data in the selected range.",
  className,
  children,
}: {
  title: string;
  description?: string;
  isEmpty: boolean;
  emptyMessage?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex-1">
        {isEmpty ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
