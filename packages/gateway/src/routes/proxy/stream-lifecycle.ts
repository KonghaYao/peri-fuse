import type { SSEStreamingApi } from "hono/streaming";
import { hookRegistry } from "../../hooks/registry.js";
import type { HookContext } from "../../hooks/types.js";
import type { RouteResult } from "../../router/index.js";

/** Hono swallows writer errors, so check cancellation after every SSE write. */
export async function runStream(
  stream: SSEStreamingApi,
  controller: AbortController,
  requestSignal: AbortSignal,
  result: RouteResult,
  ctx: HookContext,
  write: (checked: Pick<SSEStreamingApi, "writeSSE">) => Promise<void>,
): Promise<void> {
  const cancelUpstream = () => {
    try {
      result.cancel?.();
    } catch (error) {
      console.warn("[gateway] Upstream cancellation failed:", error);
    }
  };
  const aborted = () => {
    controller.abort(new DOMException("Client disconnected", "AbortError"));
    cancelUpstream();
  };
  stream.onAbort(aborted);
  const lifetime = result.signal ? AbortSignal.any([requestSignal, result.signal]) : requestSignal;
  const onSignalAbort = () => stream.abort();
  lifetime.addEventListener("abort", onSignalAbort, { once: true });
  const checked = {
    async writeSSE(message: Parameters<SSEStreamingApi["writeSSE"]>[0]) {
      controller.signal.throwIfAborted();
      await stream.writeSSE(message);
      if (stream.aborted) aborted();
      controller.signal.throwIfAborted();
    },
  };
  try {
    if (lifetime.aborted) stream.abort();
    if (stream.aborted) aborted();
    controller.signal.throwIfAborted();
    await write(checked);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    hookRegistry.runPostFailure(ctx, failure);
    if (!stream.aborted && !controller.signal.aborted) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          type: "error",
          error: { type: "api_error", message: failure.message },
        }),
      });
    }
  } finally {
    lifetime.removeEventListener("abort", onSignalAbort);
    cancelUpstream();
    // Idempotent if the write callback already reported success or failure.
    hookRegistry.runPostFailure(ctx, new Error("Stream ended before request completion"));
  }
}
