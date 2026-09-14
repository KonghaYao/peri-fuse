/**
 * Theme store — dark-first, persisted to localStorage.
 *
 * The initial class is applied by the inline script in index.html before
 * first paint; this module keeps the app in sync and handles toggling.
 */
import { createSignal } from "solid-js";

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

const [theme, setThemeSignal] = createSignal<Theme>(read());
apply(theme());

export function getTheme(): Theme {
  return theme();
}

export function setTheme(next: Theme): void {
  setThemeSignal(next);
  apply(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore (private mode)
  }
}

export function toggleTheme(): void {
  setTheme(theme() === "dark" ? "light" : "dark");
}

/** Reactive accessor for the current theme. */
export function useTheme() {
  return theme;
}
