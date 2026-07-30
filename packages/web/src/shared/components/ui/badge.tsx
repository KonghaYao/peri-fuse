import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/shared/lib/utils";

// Spectra §6.5 — 20px tall, radius-sm, subtle semantic tints.
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-[11px] font-medium leading-4 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-brand text-brand-fg hover:bg-brand-strong",
        secondary: "border-transparent bg-surface-inset text-fg-secondary",
        destructive: "border-transparent bg-danger text-white hover:bg-danger/80",
        outline: "border-border text-fg-secondary",
        brand: "border-transparent bg-brand-subtle text-brand",
        success: "border-transparent bg-success-subtle text-success",
        warning: "border-transparent bg-warning-subtle text-warning",
        error: "border-transparent bg-danger-subtle text-danger",
        info: "border-transparent bg-info-subtle text-info",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
