/** Bounded process cache with active expiration, including entries never read again. */
export class BoundedTtlMap<V> extends Map<string, V> {
  private expirations = new Map<string, number>();
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private capacity: number,
    private ttlMs: number,
  ) {
    super();
    this.timer = setInterval(() => this.sweep(), Math.min(ttlMs, 30_000));
    this.timer.unref();
  }

  override get(key: string): V | undefined {
    const expiresAt = this.expirations.get(key);
    if (expiresAt !== undefined && expiresAt <= Date.now()) this.delete(key);
    return super.get(key);
  }

  override set(key: string, value: V): this {
    this.delete(key);
    while (this.size >= this.capacity) {
      const oldest = this.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.expirations.set(key, Date.now() + this.ttlMs);
    return super.set(key, value);
  }

  override delete(key: string): boolean {
    this.expirations.delete(key);
    return super.delete(key);
  }

  override clear(): void {
    this.expirations.clear();
    super.clear();
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.expirations) {
      if (expiresAt <= now) this.delete(key);
    }
  }

  destroy(): void {
    clearInterval(this.timer);
    this.clear();
  }
}
