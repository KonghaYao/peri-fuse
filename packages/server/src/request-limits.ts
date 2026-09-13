import { withTelemetryQuerySignal } from "@peri-fuse/shared/src/server/adapters";
import type { MiddlewareHandler } from "hono";
import type { LiteServerEnv } from "./auth";

export function configuredLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function cancelUnusedBody(body: ReadableStream<Uint8Array> | null): void {
  if (body && !body.locked) void body.cancel().catch(() => {});
}

/** Bound active handlers/bodies and stream request bytes without making a second copy. */
export function requestLimits(
  options: { maxActive?: number; maxBodyBytes?: number } = {},
): MiddlewareHandler<LiteServerEnv> {
  const maxActive = options.maxActive ?? configuredLimit("LITE_MAX_ACTIVE_REQUESTS", 64);
  const maxBodyBytes =
    options.maxBodyBytes ?? configuredLimit("LITE_MAX_REQUEST_BYTES", 16 * 1024 * 1024);
  let active = 0;
  return async (c, next) => {
    if (active >= maxActive) {
      cancelUnusedBody(c.req.raw.body);
      c.header("Retry-After", "1");
      return c.json({ message: "Server request capacity reached. Retry shortly." }, 503);
    }
    active++;
    const signal = c.req.raw.signal;
    const upload = new AbortController();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      signal.removeEventListener("abort", abort);
      reader?.releaseLock();
    };
    let exceeded = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    const cancelResponse = (reason: unknown): Promise<void> => {
      if (!reader) return Promise.resolve();
      cancellation ??= reader
        .cancel(reason)
        .catch(() => {})
        .finally(release);
      return cancellation;
    };
    const abort = () => {
      // Aborting the request must interrupt body readers too; Request.signal
      // alone does not cancel a TransformStream consumed by request.json().
      upload.abort(signal.reason);
      // Keep the slot while a handler is running. Once a response exists, wait
      // for its cancellation so uncooperative producers cannot bypass capacity.
      if (reader) void cancelResponse(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const raw = c.req.raw;
      if (Number(raw.headers.get("content-length")) > maxBodyBytes) {
        cancelUnusedBody(raw.body);
        release();
        return c.json({ message: "Request body exceeds the configured byte limit" }, 413);
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
        const init = { body: limited, duplex: "half" };
        c.req.raw = new Request(raw, init);
      }
      try {
        await withTelemetryQuerySignal(signal, next);
      } finally {
        // A handler may reject authentication or ignore the body entirely.
        // Cancel the owned pipe even if its readable is locked by a body reader.
        upload.abort(new Error("Request handler finished"));
      }
      if (exceeded)
        c.res = c.json({ message: "Request body exceeds the configured byte limit" }, 413);
      const response = c.res;
      if (!response.body) {
        release();
        return;
      }
      reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            const item = await reader!.read();
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
      upload.abort(error);
      cancelUnusedBody(c.req.raw.body);
      release();
      if (exceeded)
        return c.json({ message: "Request body exceeds the configured byte limit" }, 413);
      throw error;
    }
  };
}
