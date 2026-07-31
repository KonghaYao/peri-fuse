/**
 * Provider status badge with color coding.
 */
import { cn } from "@/shared/lib/utils";

const statusStyles: Record<string, string> = {
  healthy: "bg-success-subtle text-success border-success/30",
  cooldown: "bg-warning-subtle text-warning border-warning/30",
  disabled: "bg-muted text-fg-tertiary border-border",
};

export function StatusBadge({ status }: { status: string }) {
  const style = statusStyles[status] ?? "bg-muted text-fg-secondary border-border";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize",
        style,
      )}
    >
      {status}
    </span>
  );
}
