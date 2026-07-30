/**
 * Global auto-refresh interval store (Spectra §9 — live data controls).
 *
 * A module-level store (same pattern as theme.ts) persisted to localStorage.
 * Query hooks read it via useRefreshInterval() and pass it to React Query as
 * `refetchInterval`, so every mounted list query polls at the chosen cadence.
 * 0 disables polling.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "peri-fuse-refresh-interval";

/** Polling cadences offered by <AutoRefreshControl/> (ms; 0 = off). */
export const REFRESH_OPTIONS = [0, 15_000, 30_000, 60_000] as const;

function readStored(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

let intervalMs = readStored();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getRefreshInterval(): number {
  return intervalMs;
}

export function setRefreshInterval(ms: number) {
  intervalMs = ms;
  try {
    localStorage.setItem(STORAGE_KEY, String(ms));
  } catch {
    // Storage unavailable — keep the in-memory value.
  }
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook — re-renders the consumer whenever the cadence changes. */
export function useRefreshInterval(): number {
  return useSyncExternalStore(subscribe, getRefreshInterval, () => 0);
}
