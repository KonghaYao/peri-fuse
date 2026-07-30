/**
 * Theme store — dark-first, persisted to localStorage.
 *
 * The initial class is applied by the inline script in index.html before
 * first paint; this module keeps React in sync and handles toggling.
 */
import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "peri-fuse-theme";

function read(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

let cache: Theme = read();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getTheme(): Theme {
  return cache;
}

export function setTheme(theme: Theme): void {
  cache = theme;
  apply(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore (private mode)
  }
  emit();
}

export function toggleTheme(): void {
  setTheme(cache === "dark" ? "light" : "dark");
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook returning the current theme (re-renders on change). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
