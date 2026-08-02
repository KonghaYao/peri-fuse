/**
 * Load-generation engine for stress tests.
 *
 * Runs a pool of concurrent workers, each repeatedly invoking an async `task`
 * until a time budget is exhausted. Supports an optional global rate limit
 * (leaky bucket) and a live progress ticker. Recording is delegated to a
 * `record(result)` callback so callers can route results to one or more
 * Stats collectors (e.g. per-endpoint breakdowns).
 */

import { Stats } from "./stats.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Global leaky-bucket rate limiter. Returns an async function that waits
 * until the caller's slot is due. Returns null when rps is falsy (unlimited).
 */
export function makeLimiter(rps) {
  if (!rps || rps <= 0) return null;
  const interval = 1000 / rps;
  let next = performance.now();
  return async () => {
    const now = performance.now();
    const slot = Math.max(next, now);
    next = slot + interval;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  };
}

/** Default recorder: route a result into a single Stats collector. */
export function recordInto(stats) {
  return (r) => {
    if (r.ok) {
      stats.recordOk(r.ms, { events: r.events ?? 0, bytes: r.bytes ?? 0 });
    } else {
      stats.recordError(r.ms, r.status);
    }
  };
}

/**
 * Drive load for `duration` seconds with `concurrency` parallel workers.
 *
 * @param {object} opts
 * @param {number} opts.concurrency      number of parallel workers
 * @param {number} opts.duration         seconds to run
 * @param {(workerIndex:number)=>Promise<object>} opts.task
 *        async function performing one request; must resolve to a result of
 *        the shape { ok, status, ms, events?, bytes? } (never throws).
 * @param {(result:object)=>void} opts.record  called with each result
 * @param {number} [opts.targetRps]      optional global requests/sec cap
 * @param {number} [opts.progressEvery]  seconds between progress lines
 * @param {Stats}  [opts.stats]          Stats used for the progress ticker
 * @returns {Promise<void>}
 */
export async function runLoad({
  concurrency,
  duration,
  task,
  record,
  targetRps = 0,
  progressEvery = 2,
  stats = null,
}) {
  if (duration <= 0 || concurrency <= 0) return;

  const stopAt = Date.now() + duration * 1000;
  const limiter = makeLimiter(targetRps);
  let stopped = false;

  const ticker =
    progressEvery > 0
      ? setInterval(() => {
          if (stats) console.log(stats.progressLine());
        }, progressEvery * 1000)
      : null;

  async function worker(idx) {
    while (!stopped) {
      if (Date.now() >= stopAt) {
        stopped = true;
        break;
      }
      if (limiter) await limiter();
      if (Date.now() >= stopAt) {
        stopped = true;
        break;
      }
      let result;
      try {
        result = await task(idx);
      } catch {
        result = { ok: false, status: "exception", ms: 0 };
      }
      try {
        record(result);
      } catch {
        // recording must never break the loop
      }
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
  await Promise.all(workers);
  stopped = true;
  if (ticker) clearInterval(ticker);
}

/**
 * Convenience: create a Stats, run load into it, stop it, and return it.
 */
export async function runAndCollect(label, opts) {
  const stats = new Stats(label);
  stats.start();
  await runLoad({ ...opts, stats, record: opts.record ?? recordInto(stats) });
  stats.stop();
  return stats;
}
