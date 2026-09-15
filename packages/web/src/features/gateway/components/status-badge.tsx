import { cn } from "@/shared/lib/utils";

const statusStyles: Record<string, string> = {
  healthy: "bg-success-subtle text-success border-success/30",
  cooldown: "bg-warning-subtle text-warning border-warning/30",
  disabled: "bg-muted text-fg-tertiary border-border",
};

export function StatusBadge(props: { status: string }) {
  const style = () => statusStyles[props.status] ?? "bg-muted text-fg-secondary border-border";
  return (
    <span
      class={cn(
        "inline-flex items-center rounded-full border px-8 py-2 text-[11px] font-medium capitalize",
        style(),
      )}
    >
      {props.status}
    </span>
  );
}
