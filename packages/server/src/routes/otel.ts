/**
 * POST /api/public/otel/v1/traces
 *
 * Simplified port of web/src/pages/api/public/otel/v1/traces/index.ts.
 * Supports both JSON and protobuf OTLP encodings (the Python SDK v4+
 * defaults to protobuf). In lite mode, `publishToOtelIngestionQueue`
 * processes inline via `processEventBatchLite` (no S3/Redis/worker).
 */

import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  createIngestionAttribution,
  getLangfuseHeaderValue,
  type IngestionHeaderMap,
  logger,
  markProjectAsOtelUser,
  OtelIngestionProcessor,
} from "@peri-fuse/shared/src/server";
import { Hono } from "hono";
import { authMiddleware, type LiteServerEnv } from "../auth";
import { $root } from "../otel-proto/root";
import { configuredLimit } from "../request-limits";

const app = new Hono<LiteServerEnv>();
const decompress = promisify(gunzip);

app.post("/api/public/otel/v1/traces", authMiddleware, async (c) => {
  const auth = c.get("auth");

  let body: Uint8Array;
  try {
    body = new Uint8Array(await c.req.arrayBuffer());
  } catch (e) {
    logger.error(`Failed to read request body`, e);
    return c.json({ error: "Failed to read request body" }, 400);
  }

  if (c.req.header("content-encoding")?.includes("gzip")) {
    try {
      body = await decompress(body, {
        maxOutputLength: configuredLimit("LITE_MAX_DECOMPRESSED_BYTES", 32 * 1024 * 1024),
      });
    } catch (e) {
      if (e instanceof RangeError) {
        return c.json({ error: "Decompressed request exceeds the configured byte limit" }, 413);
      }
      logger.error(`Failed to decompress request body`, e);
      return c.json({ error: "Failed to decompress request body" }, 400);
    }
  }

  const contentType = c.req.header("content-type")?.toLowerCase();
  if (
    !contentType ||
    (!contentType.includes("application/json") && !contentType.includes("application/x-protobuf"))
  ) {
    logger.error(`Invalid content type: ${contentType}`);
    return c.json({ error: "Invalid content type" }, 400);
  }

  let resourceSpans: any;
  if (contentType.includes("application/x-protobuf")) {
    try {
      const parsed =
        $root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest.decode(body);
      resourceSpans =
        $root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest.toObject(
          parsed,
          // OTLP JSON encodes int64 fields as decimal strings.
          { longs: String },
        ).resourceSpans;
    } catch (e) {
      logger.error(`Failed to parse OTel Protobuf`, e);
      return c.json({ error: "Failed to parse OTel Protobuf Trace" }, 400);
    }
  } else {
    try {
      resourceSpans = JSON.parse(new TextDecoder().decode(body)).resourceSpans;
    } catch (e) {
      logger.error(`Failed to parse OTel JSON`, e);
      return c.json({ error: "Failed to parse OTel JSON Trace" }, 400);
    }
  }

  if (!resourceSpans || resourceSpans.length === 0) {
    return c.json({});
  }

  const headers: IngestionHeaderMap = Object.fromEntries(c.req.raw.headers.entries());
  const attribution = createIngestionAttribution({ headers, authCheck: auth });
  const ingestionVersion = getLangfuseHeaderValue(headers, "x-langfuse-ingestion-version");

  // Reject unsupported future ingestion versions (> 4), same as web.
  const parsedIngestionVersion = ingestionVersion ? parseInt(ingestionVersion, 10) : undefined;
  if (
    parsedIngestionVersion !== undefined &&
    (Number.isNaN(parsedIngestionVersion) || parsedIngestionVersion > 4)
  ) {
    return c.json(
      {
        error: `Unsupported x-langfuse-ingestion-version: "${ingestionVersion}". Maximum supported: "4".`,
      },
      400,
    );
  }

  // Best-effort marker that this project uses the OTEL API (Prisma/SQLite).
  await markProjectAsOtelUser(auth.scope.projectId).catch((e) =>
    logger.warn(`Failed to mark project as OTEL user: ${e}`),
  );

  const processor = new OtelIngestionProcessor({
    projectId: auth.scope.projectId,
    publicKey: auth.scope.publicKey,
    orgId: auth.scope.orgId,
    sdkName: attribution.ingestionSdkName,
    sdkVersion: attribution.ingestionSdkVersion,
    ingestionVersion,
  });

  const result = await (processor.publishToOtelIngestionQueue(resourceSpans) as Promise<any>);
  return c.json(result ?? {});
});

export default app;
