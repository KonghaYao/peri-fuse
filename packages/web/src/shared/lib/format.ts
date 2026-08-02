/**
 * Small display formatters shared across the lite-web pages.
 */

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

/** ISO date-time -> local "Mar 4, 2025, 3:41:02 PM". Empty string for falsy. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : dateTimeFmt.format(d);
}

/** Seconds -> "1.24 s" / "312 ms". */
export function formatLatency(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  return `${seconds.toFixed(2)} s`;
}

/** Milliseconds -> "812 ms" / "2.0 s" / "1m 5s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** USD cost -> "$0.002134" (6 significant-ish digits for tiny costs). */
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || cost < 0) return "—";
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toPrecision(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Token count -> "1.2k" / "3.4M" style compact display. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

/** Plain integer with thousands separators. */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Intl.NumberFormat(undefined).format(n);
}

/** Fraction (0-1) -> "12.3%" style percentage display. */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined) return "—";
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Observation start/end -> duration "812 ms". */
export function formatDuration(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): string {
  if (!startTime || !endTime) return "—";
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Truncate long strings for table cells. */
export function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------------------------------------------------------------------
// Ports of web/src/utils/numbers.ts + dates.ts formatters (used by the
// replicated trace/session table columns).
// ---------------------------------------------------------------------------

export const compactNumberFormatter = (number?: number | bigint, maxFractionDigits?: number) => {
  return Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: maxFractionDigits ?? 2,
  }).format(number ?? 0);
};

export const numberFormatter = (
  number?: number | bigint,
  fractionDigits?: number,
  maxFractionDigits?: number,
) => {
  return Intl.NumberFormat("en-US", {
    notation: "standard",
    useGrouping: true,
    minimumFractionDigits: fractionDigits ?? 2,
    maximumFractionDigits: maxFractionDigits ?? fractionDigits ?? 2,
  }).format(number ?? 0);
};

export const usdFormatter = (
  number?: number | bigint,
  minimumFractionDigits = 2,
  maximumFractionDigits = 6,
) => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(number ?? 0);
};

export const costFormatter = (totalCost?: number | null) => {
  return totalCost
    ? totalCost < 5
      ? usdFormatter(totalCost, 2, 6)
      : usdFormatter(totalCost, 2, 2)
    : usdFormatter(0);
};

export const formatTokenCounts = (
  inputUsage?: number | null,
  outputUsage?: number | null,
  totalUsage?: number | null,
  showLabels = false,
): string => {
  if (!inputUsage && !outputUsage && !totalUsage) return "";

  return showLabels
    ? `${numberFormatter(inputUsage ?? 0, 0)} prompt → ${numberFormatter(outputUsage ?? 0, 0)} completion (∑ ${numberFormatter(totalUsage ?? 0, 0)})`
    : `${numberFormatter(inputUsage ?? 0, 0)} → ${numberFormatter(outputUsage ?? 0, 0)} (∑ ${numberFormatter(totalUsage ?? 0, 0)})`;
};

/** Seconds -> "1h 02m 03s" / "2m 05s" / "1.24s" (web/src/utils/dates.ts). */
export const formatIntervalSeconds = (seconds: number | null | undefined, scale = 2) => {
  if (seconds === null || seconds === undefined) return "—";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (num: number) => String(num).padStart(2, "0");

  if (hrs > 0) return `${hrs}h ${pad(mins)}m ${pad(secs)}s`;
  if (mins > 0) return `${mins}m ${pad(secs)}s`;
  return `${seconds.toFixed(scale)}s`;
};
