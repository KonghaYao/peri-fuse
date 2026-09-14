import {
  bindCommandPaletteHotkey,
  bindCommandPaletteOpenEvent,
  bindShortcutsHelpHotkey,
  CommandPaletteShell,
  dispatchCommandPaletteOpen,
  type ShortcutEntry,
  ShortcutsDialogShell,
} from "@peri/ui";
import { useNavigate } from "@solidjs/router";
import { type Component, createMemo, createSignal, onMount } from "solid-js";
import { hasActiveProject } from "@/shared/store/project";
import { toggleTheme, useTheme } from "@/shared/store/theme";
import { buildCommandPaletteItems } from "./command-palette-items";

const SHORTCUTS: ShortcutEntry[] = [
  { keys: ["⌘", "K"], label: "Open command palette" },
  { keys: ["J"], label: "Select next trace" },
  { keys: ["K"], label: "Select previous trace" },
  { keys: ["Esc"], label: "Close peek panel / dialog" },
  { keys: ["?"], label: "Show keyboard shortcuts" },
];

/** Global command palette + shortcuts help mounted once in the app shell. */
export const AppChrome: Component = () => {
  const navigate = useNavigate();
  const theme = useTheme();
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);

  onMount(() => {
    const cleanPalette = bindCommandPaletteHotkey(() => setPaletteOpen((open) => !open));
    const cleanOpenEvent = bindCommandPaletteOpenEvent(() => setPaletteOpen(true));
    const cleanShortcuts = bindShortcutsHelpHotkey(() => setShortcutsOpen(true));
    return () => {
      cleanPalette();
      cleanOpenEvent();
      cleanShortcuts();
    };
  });

  const items = createMemo(() =>
    buildCommandPaletteItems({
      navigate,
      hasProject: hasActiveProject(),
      theme: theme(),
      onToggleTheme: toggleTheme,
    }),
  );

  return (
    <>
      <CommandPaletteShell
        open={paletteOpen()}
        onOpenChange={setPaletteOpen}
        placeholder="Type a command or search…"
        emptyMessage="No matching commands."
        items={items()}
      />
      <ShortcutsDialogShell
        open={shortcutsOpen()}
        onOpenChange={setShortcutsOpen}
        shortcuts={SHORTCUTS}
      />
    </>
  );
};

/** Imperatively open the command palette from sidebar triggers. */
export function openCommandPalette(): void {
  dispatchCommandPaletteOpen();
}
