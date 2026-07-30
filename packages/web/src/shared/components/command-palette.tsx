/**
 * Global Command Palette — Spectra §7 / §10.
 *
 * Opens with Cmd+K (mac) / Ctrl+K. Provides keyboard-first navigation to
 * every page plus quick actions (theme toggle). Fuzzy-filters as you type;
 * ArrowUp/Down + Enter to select, Esc to dismiss. Zero new dependencies —
 * built directly on Radix Dialog.
 */
import {
  Activity,
  CornerDownLeft,
  Gauge,
  ListTree,
  Moon,
  Search,
  Settings as SettingsIcon,
  Star,
  Sun,
  UserRound,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Dialog, DialogContent, DialogTitle } from "@/shared/components/ui/dialog";
import { cn } from "@/shared/lib/utils";
import { useProjectContext } from "@/shared/store/project";
import { toggleTheme, useTheme } from "@/shared/store/theme";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: typeof Gauge;
  keywords: string;
  action: () => void;
}

/** Custom event used by external triggers (sidebar button) to open the palette. */
export const OPEN_COMMAND_PALETTE_EVENT = "open-command-palette";

/** Imperatively open the palette from anywhere. */
export function openCommandPalette() {
  document.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const ctx = useProjectContext();
  const theme = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Global Cmd+K / Ctrl+K listener + external open events (from the trigger).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    function onOpenEvent() {
      setOpen(true);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    };
  }, []);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      {
        id: "dashboard",
        label: "Go to Dashboard",
        icon: Gauge,
        keywords: "dashboard home overview stats",
        action: () => navigate("/dashboard"),
      },
      {
        id: "traces",
        label: "Go to Traces",
        icon: ListTree,
        keywords: "traces spans llm calls",
        action: () => navigate("/traces"),
      },
      {
        id: "sessions",
        label: "Go to Sessions",
        icon: Users,
        keywords: "sessions conversations threads",
        action: () => navigate("/sessions"),
      },
      {
        id: "users",
        label: "Go to Users",
        icon: UserRound,
        keywords: "users people accounts usage",
        action: () => navigate("/users"),
      },
      {
        id: "observations",
        label: "Go to Observations",
        icon: Activity,
        keywords: "observations generations spans events",
        action: () => navigate("/observations"),
      },
      {
        id: "scores",
        label: "Go to Scores",
        icon: Star,
        keywords: "scores evaluations ratings",
        action: () => navigate("/scores"),
      },
      {
        id: "settings",
        label: "Go to Settings",
        icon: SettingsIcon,
        keywords: "settings api keys configuration",
        action: () => navigate("/settings"),
      },
    ];
    const actions: Command[] = [
      {
        id: "theme",
        label: theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode",
        hint: "Appearance",
        icon: theme === "dark" ? Sun : Moon,
        keywords: "theme dark light appearance mode toggle",
        action: () => toggleTheme(),
      },
    ];
    // Only offer navigation when a project is active.
    return ctx ? [...nav, ...actions] : actions;
  }, [navigate, ctx, theme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Reset selection whenever the query changes (handled in onChange below).

  // Keep the active item scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const runCommand = (cmd: Command) => {
    setOpen(false);
    setQuery("");
    cmd.action();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % Math.max(filtered.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[activeIndex];
      if (cmd) runCommand(cmd);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) {
          setActiveIndex(0);
        } else {
          setQuery("");
        }
      }}
    >
      <DialogContent
        hideClose
        className="top-[20%] translate-y-0 gap-0 overflow-hidden rounded-xl bg-popover p-0 shadow-lg sm:max-w-lg sm:rounded-xl"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>

        {/* Search input */}
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-fg-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search…"
            autoFocus
            className="flex h-12 w-full bg-transparent text-md text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
          />
          <kbd className="hidden shrink-0 rounded border border-border bg-surface-inset px-1.5 py-0.5 font-mono text-[10px] text-fg-tertiary sm:block">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-fg-tertiary">
              No results for “{query}”
            </p>
          ) : (
            filtered.map((cmd, index) => {
              const Icon = cmd.icon;
              const isActive = index === activeIndex;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  data-index={index}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runCommand(cmd)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors duration-150",
                    isActive ? "bg-brand-subtle text-brand" : "text-fg-primary",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                  <span className="flex-1 truncate">{cmd.label}</span>
                  {cmd.hint && <span className="text-xs text-fg-tertiary">{cmd.hint}</span>}
                  {isActive && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-brand" />}
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 border-t border-border bg-surface-inset/50 px-4 py-2">
          <span className="flex items-center gap-1 text-[11px] text-fg-tertiary">
            <kbd className="rounded border border-border bg-surface-inset px-1 font-mono">↑</kbd>
            <kbd className="rounded border border-border bg-surface-inset px-1 font-mono">↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1 text-[11px] text-fg-tertiary">
            <kbd className="rounded border border-border bg-surface-inset px-1 font-mono">↵</kbd>
            select
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
