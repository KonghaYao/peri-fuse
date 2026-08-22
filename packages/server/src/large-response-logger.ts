import { logger } from "@peri-fuse/shared/src/server";
import type { MiddlewareHandler } from "hono";
import type { LiteServerEnv } from "./auth";

export const DEFAULT_LARGE_RESPONSE_THRESHOLD_BYTES = 1024 * 1024;

export type LargeResponseLog = {
  event: "large_api_response";
  method: string;
  path: string;
  status: number;
  bytes: number;
  durationMs: number;
  projectId: string | null;
  cache: string | null;
};

type LargeResponseLoggerOptions = {
  thresholdBytes?: number;
  write?: (entry: LargeResponseLog) => void;
};

function configuredThreshold(): number {
  const configured = Number(process.env.LITE_LARGE_RESPONSE_THRESHOLD_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_LARGE_RESPONSE_THRESHOLD_BYTES;
}

/**
 * Count API response bytes as they are consumed by the HTTP adapter. The body
 * is never cloned or buffered, so observability does not amplify large payloads.
 */
export function largeResponseLogger(
  options: LargeResponseLoggerOptions = {},
): MiddlewareHandler<LiteServerEnv> {
  const thresholdBytes = options.thresholdBytes ?? configuredThreshold();
  const write =
    options.write ??
    ((entry: LargeResponseLog) => logger.warn(`[lite-server] ${JSON.stringify(entry)}`));

  return async (c, next) => {
    if (!c.req.path.startsWith("/api/")) return next();

    const startedAt = performance.now();
    await next();

    const response = c.res;
    if (!response.body) return;

    let bytes = 0;
    const countingStream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        if (bytes < thresholdBytes) return;
        try {
          write({
            event: "large_api_response",
            method: c.req.method,
            path: c.req.path,
            status: response.status,
            bytes,
            durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
            projectId: c.get("auth")?.scope?.projectId ?? null,
            cache: response.headers.get("x-cache"),
          });
        } catch {
          // Observability must never turn a successful API stream into a failure.
        }
      },
    });

    c.res = new Response(response.body.pipeThrough(countingStream), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
