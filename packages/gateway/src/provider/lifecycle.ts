/** A fetch deadline whose timer and downstream listener are released at completion. */
export function createAbortScope(timeoutMs: number, downstream?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(downstream?.reason);
  if (downstream?.aborted) onAbort();
  else downstream?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose() {
      clearTimeout(timer);
      downstream?.removeEventListener("abort", onAbort);
    },
  };
}

/** Read at most limit bytes; cancel unread network data on error, abort or overflow. */
export async function readBoundedText(
  response: Response,
  limit: number,
  signal: AbortSignal,
  truncate = false,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let buffer = new Uint8Array(0);
  let length = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value.byteLength === 0) continue;
      const accepted = Math.min(value.byteLength, limit - length);
      if (accepted < value.byteLength && !truncate) {
        throw new Error(`Provider response exceeds ${limit} bytes`);
      }
      if (length + accepted > buffer.byteLength) {
        const capacity = Math.min(limit, Math.max(4096, buffer.byteLength * 2, length + accepted));
        const grown = new Uint8Array(capacity);
        grown.set(buffer.subarray(0, length));
        buffer = grown;
      }
      buffer.set(value.subarray(0, accepted), length);
      length += accepted;
      if (accepted < value.byteLength) break;
    }
    return Buffer.from(buffer.buffer, buffer.byteOffset, length).toString("utf8");
  } finally {
    buffer = new Uint8Array(0);
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
