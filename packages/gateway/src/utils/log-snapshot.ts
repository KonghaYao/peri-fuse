/** Copy a bounded part of JSON-like telemetry without first serializing the full input. */
export function logSnapshot(value: unknown, maxBytes: number): unknown {
  let remaining = Math.max(0, Math.min(Number.isFinite(maxBytes) ? maxBytes : 10240, 1024 * 1024));
  let nodes = 256;
  const seen = new WeakSet<object>();
  function copy(item: unknown, depth: number): unknown {
    if (remaining <= 0 || --nodes < 0 || depth > 8) return "[truncated]";
    remaining -= 16;
    if (typeof item === "string") {
      const prefix = item.slice(0, Math.max(0, Math.floor(remaining / 4)));
      remaining -= Buffer.byteLength(prefix);
      return prefix.length < item.length ? `${prefix}[truncated]` : prefix;
    }
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (const entry of item) {
        if (remaining <= 0 || nodes <= 0) {
          result.push("[truncated]");
          break;
        }
        result.push(copy(entry, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (remaining <= 0 || nodes <= 0) {
        result._truncated = true;
        break;
      }
      remaining -= Math.min(key.length, 128) * 4;
      const entry = (item as Record<string, unknown>)[key];
      Object.defineProperty(result, key.slice(0, 128), {
        value: copy(entry, depth + 1),
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  }
  return copy(value, 0);
}
