/** Read a bounded prefix using one coalesced buffer; oversized bodies continue streaming. */
export async function bufferSmallResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ response: Response; body?: Uint8Array<ArrayBuffer> }> {
  if (!response.body) return { response, body: new Uint8Array() };
  if (Number(response.headers.get("content-length")) > maxBytes) return { response };
  const reader = response.body.getReader();
  let prefix = new Uint8Array(0);
  let length = 0;
  let overflow: Uint8Array | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const abort = () => {
    prefix = new Uint8Array(0);
    overflow = undefined;
    void reader
      .cancel(signal.reason)
      .catch(() => {})
      .finally(release);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        const body = prefix.slice(0, length);
        prefix = new Uint8Array(0);
        release();
        return { response: new Response(body, response), body };
      }
      // Tiny/empty chunks must not accumulate one retained object per read.
      if (value.byteLength === 0) continue;
      if (length + value.byteLength > maxBytes) {
        overflow = value;
        break;
      }
      if (length + value.byteLength > prefix.byteLength) {
        const capacity = Math.min(
          maxBytes,
          Math.max(4096, prefix.byteLength * 2, length + value.byteLength),
        );
        const grown = new Uint8Array(capacity);
        grown.set(prefix.subarray(0, length));
        prefix = grown;
      }
      prefix.set(value, length);
      length += value.byteLength;
    }
  } catch (error) {
    abort();
    throw error;
  }
  // No tee/clone: the bounded prefix, first overflowing chunk and original reader
  // form one response. At most two chunks are retained regardless of source chunking.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        if (length) {
          const chunk = prefix.subarray(0, length);
          prefix = new Uint8Array(0);
          length = 0;
          controller.enqueue(chunk);
          return;
        }
        if (overflow) {
          const chunk = overflow;
          overflow = undefined;
          controller.enqueue(chunk);
          return;
        }
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        abort();
      }
    },
    async cancel(reason) {
      prefix = new Uint8Array(0);
      overflow = undefined;
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return { response: new Response(body, response) };
}
