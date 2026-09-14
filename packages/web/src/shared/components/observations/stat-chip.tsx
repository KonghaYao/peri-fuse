import type { Component, JSX } from "solid-js";

export const StatChip: Component<{
  icon: Component<{ class?: string; size?: number }>;
  label: string;
  value: string;
}> = (props) => {
  const Icon = props.icon;
  return (
    <div class="flex items-center gap-2 rounded-md border border-line bg-surface-inset/60 px-3 py-2">
      <Icon class="h-4 w-4 text-fg-tertiary" size={16} />
      <div class="leading-tight">
        <div class="text-[10px] uppercase tracking-[0.06em] text-fg-tertiary">{props.label}</div>
        <div class="tnum text-sm font-semibold text-fg-primary">{props.value}</div>
      </div>
    </div>
  );
};
