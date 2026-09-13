import type { MiddlewareHandler } from "hono";
import type { GatewayEnv } from "../app.js";

function configuredLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Standalone Gateway admission; embedded routes use the server's shared limiter. */
export function gatewayRequestLimits(
  options: { maxActive?: number; maxBodyBytes?: number } = {},
): MiddlewareHandler<GatewayEnv> {
  const maxActive = options.maxActive ?? configuredLimit("GATEWAY_MAX_ACTIVE_REQUESTS", 64);
  const maxBodyBytes =
    options.maxBodyBytes ?? configuredLimit("GATEWAY_MAX_REQUEST_BYTES", 16 * 1024 * 1024);
  let active = 0;
  return async (c, next) => {
    if (active >= maxActive) {
      void c.req.raw.body?.cancel().catch(() => {});
      c.header("Retry-After", "1");
      return c.json(
        { error: { message: "Gateway request capacity reached. Retry shortly." } },
        503,
      );
    }
    active++;
    const signal = c.req.raw.signal;
    const upload = new AbortController();
    let released = false;
    let exceeded = false;
    let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      signal.removeEventListener("abort", abort);
      responseReader?.releaseLock();
    };
    let cancellation: Promise<void> | undefined;
    const cancelResponse = (reason: unknown): Promise<void> => {
      if (!responseReader) return Promise.resolve();
      cancellation ??= responseReader
        .cancel(reason)
        .catch(() => {})
        .finally(release);
      return cancellation;
    };
    const abort = () => {
      upload.abort(signal.reason);
      if (responseReader) void cancelResponse(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    const tooLarge = () =>
      c.json({ error: { message: "Request body exceeds the configured byte limit" } }, 413);
    try {
      signal.throwIfAborted();
      const raw = c.req.raw;
      if (Number(raw.headers.get("content-length")) > maxBodyBytes) {
        void raw.body?.cancel().catch(() => {});
        release();
        return tooLarge();
      }
      if (raw.body) {
        let bytes = 0;
        const limited = raw.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > maxBodyBytes) {
                exceeded = true;
                throw new Error("Request body exceeds the configured byte limit");
              }
              controller.enqueue(chunk);
            },
          }),
          { signal: upload.signal },
        );
        c.req.raw = new Request(raw, { body: limited, duplex: "half" } as RequestInit);
      }
      try {
        await next();
      } finally {
        upload.abort();
      }
      if (exceeded) c.res = tooLarge();
      const response = c.res;
      if (!response.body) {
        release();
        return;
      }
      const reader = response.body.getReader();
      responseReader = reader;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const item = await reader.read();
            signal.throwIfAborted();
            if (item.done) {
              if (!cancellation) release();
              controller.close();
            } else controller.enqueue(item.value);
          } catch (error) {
            if (signal.aborted) void cancelResponse(signal.reason);
            else if (!cancellation) release();
            controller.error(error);
          }
        },
        cancel: cancelResponse,
      });
      c.res = new Response(body, response);
      if (signal.aborted) abort();
    } catch (error) {
      upload.abort();
      release();
      if (exceeded) return tooLarge();
      throw error;
    }
  };
}
