/**
 * Statistics collector for stress tests.
 *
 * Tracks per-request latency, throughput, and error breakdown, and renders a
 * human-readable summary with latency percentiles (p50/p90/p95/p99/max).
 *
 * Latencies are kept in a plain array and sorted once at summarize() time.
 * This is accurate and fast for typical stress runs (tens of seconds). For
 * multi-hour soak tests the array can grow large; pass `sampleRate` to the
 * constructor to keep only a random subset of latencies if memory matters
 * (percentiles stay statistically valid, counts stay exact).
 */

export class Stats {
  constructor(label, { sampleRate = 1 } = {}) {
    this.label = label;
    this.sampleRate = sampleRate;
    this.latencies = []; // successful request latencies (ms)
    this.ok = 0;
    this.errors = 0;
    this.errorByStatus = new Map();
    this.events = 0; // optional: ingested events (write tests)
    this.bytes = 0; // optional: response bytes (read tests)
    this.startedAt = 0;
    this.stoppedAt = 0;
  }

  start() {
    this.startedAt = Date.now();
    return this;
  }

  stop() {
    this.stoppedAt = Date.now();
    return this;
  }

  /** Record a successful request. `ms` is the end-to-end latency. */
  recordOk(ms, { events = 0, bytes = 0 } = {}) {
    this.ok++;
    this.events += events;
    this.bytes += bytes;
    if (this.sampleRate >= 1 || Math.random() < this.sampleRate) {
      this.latencies.push(ms);
    }
  }

  /** Record a failed request. `status` is an HTTP status or "network". */
  recordError(_ms, status) {
    this.errors++;
    const key = String(status ?? "network");
    this.errorByStatus.set(key, (this.errorByStatus.get(key) ?? 0) + 1);
  }

  get total() {
    return this.ok + this.errors;
  }

  durationSec() {
    const end = this.stoppedAt || Date.now();
    return Math.max((end - this.startedAt) / 1000, 0.001);
  }

  static percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
  }

  /** One-line live-progress snapshot (used by the runner's ticker). */
  progressLine() {
    const dur = this.durationSec();
    const errPct = this.total ? ((this.errors / this.total) * 100).toFixed(1) : "0.0";
    return (
      `[${this.label}] ${dur.toFixed(0)}s  ` +
      `${this.total} req  ${(this.total / dur).toFixed(0)} req/s  ` +
      `err=${this.errors} (${errPct}%)`
    );
  }

  /** Full multi-line summary with latency percentiles. */
  summarize() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const dur = this.durationSec();
    const rps = this.total / dur;
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const p = (q) => Stats.percentile(sorted, q).toFixed(1);

    const lines = [];
    lines.push(`\n=== ${this.label} ===`);
    lines.push(`  requests:    ${this.total}  (ok=${this.ok}  errors=${this.errors})`);
    lines.push(`  duration:    ${dur.toFixed(1)}s   throughput=${rps.toFixed(1)} req/s`);
    if (this.events > 0) {
      lines.push(`  events:      ${this.events}  (${(this.events / dur).toFixed(0)} events/s)`);
    }
    if (this.bytes > 0) {
      lines.push(`  body:        ${(this.bytes / 1024 / 1024).toFixed(1)} MiB read`);
    }
    if (sorted.length > 0) {
      lines.push(
        `  latency ms:  mean=${mean.toFixed(1)}  p50=${p(50)}  p90=${p(90)}  ` +
          `p95=${p(95)}  p99=${p(99)}  max=${sorted[sorted.length - 1].toFixed(1)}`,
      );
    }
    if (this.errors > 0) {
      const parts = [...this.errorByStatus.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`);
      lines.push(`  errors:      ${parts.join("  ")}`);
    }
    return lines.join("\n");
  }
}

/** Merge several Stats into one aggregate (latencies concatenated). */
export function mergeStats(label, statsList) {
  const merged = new Stats(label);
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  for (const s of statsList) {
    merged.ok += s.ok;
    merged.errors += s.errors;
    merged.events += s.events;
    merged.bytes += s.bytes;
    merged.latencies.push(...s.latencies);
    for (const [k, v] of s.errorByStatus) {
      merged.errorByStatus.set(k, (merged.errorByStatus.get(k) ?? 0) + v);
    }
    if (s.startedAt) earliest = Math.min(earliest, s.startedAt);
    const end = s.stoppedAt || Date.now();
    latest = Math.max(latest, end);
  }
  merged.startedAt = Number.isFinite(earliest) ? earliest : Date.now();
  merged.stoppedAt = latest;
  return merged;
}
