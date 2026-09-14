/**
 * Global auto-refresh interval store (Spectra §9 — live data controls).
 *
 * Query hooks read it via useRefreshInterval() and pass it to TanStack Query as
 * `refetchInterval`, so every mounted list query polls at the chosen cadence.
 * 0 disables polling.
 */
import { createSignal } from "solid-js";

const STORAGE_KEY = "peri-fuse-refresh-interval";

/** Polling cadences offered by AutoRefreshIntervalControl (ms; 0 = off). */
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

const [refreshInterval, setRefreshIntervalSignal] = createSignal<number>(readStored());

export function getRefreshInterval(): number {
  return refreshInterval();
}

export function setRefreshInterval(ms: number) {
  setRefreshIntervalSignal(ms);
  try {
    localStorage.setItem(STORAGE_KEY, String(ms));
  } catch {
    // Storage unavailable — keep the in-memory value.
  }
}

/** Reactive accessor for the current refresh interval. */
export function useRefreshInterval() {
  return refreshInterval;
}
