import { Search } from "lucide-solid";
import type { Component } from "solid-js";
import { openCommandPalette } from "./app-chrome";

/** Compact sidebar trigger that opens the global command palette. */
export const CommandPaletteTrigger: Component = () => (
  <button
    type="button"
    onClick={openCommandPalette}
    class="flex h-32 w-full items-center gap-8 rounded-md border border-border bg-surface-inset px-10 text-[13px] text-fg-tertiary transition-colors duration-150 hover:border-line-strong hover:text-fg-secondary"
  >
    <Search class="h-14 w-14 shrink-0" size={14} strokeWidth={1.75} />
    <span class="flex-1 truncate text-left">Search…</span>
    <kbd class="shrink-0 rounded border border-border bg-surface-raised px-6 py-2 font-mono text-[10px]">
      ⌘K
    </kbd>
  </button>
);
