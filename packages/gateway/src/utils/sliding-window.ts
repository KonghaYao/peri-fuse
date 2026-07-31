/**
 * Sliding window rate limiter (in-memory, no Redis).
 * Used for RPM/TPM limiting per API key.
 */

interface WindowEntry {
  windowStart: number;
  count: number;
}

export class SlidingWindowCounter {
  private windows = new Map<string, WindowEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cleanupIntervalMs = 60_000) {
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    // Allow process to exit even if timer is running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check if the key is within limit and increment the counter.
   * Returns true if allowed, false if rate limited.
   */
  checkAndIncrement(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      // Start a new window
      this.windows.set(key, { windowStart: now, count: 1 });
      return true;
    }

    if (entry.count >= limit) {
      return false;
    }

    entry.count++;
    return true;
  }

  /**
   * Increment by a specific amount (used for TPM after response).
   */
  incrementBy(key: string, amount: number, windowMs: number): void {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      this.windows.set(key, { windowStart: now, count: amount });
    } else {
      entry.count += amount;
    }
  }

  /**
   * Get remaining allowance for a key.
   */
  getRemaining(key: string, limit: number, windowMs: number): number {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      return limit;
    }

    return Math.max(0, limit - entry.count);
  }

  /**
   * Get the reset time (ms since epoch) for the current window.
   */
  getResetTime(key: string, windowMs: number): number {
    const entry = this.windows.get(key);
    if (!entry) {
      return Date.now() + windowMs;
    }
    return entry.windowStart + windowMs;
  }

  /**
   * Remove expired windows.
   */
  private cleanup(): void {
    const now = Date.now();
    const maxWindow = 120_000; // 2 minutes max window
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart > maxWindow) {
        this.windows.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
  }
}
