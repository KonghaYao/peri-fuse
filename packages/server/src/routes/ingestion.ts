/**
 * POST /api/public/ingestion
 *
 * Simplified port of web/src/pages/api/public/ingestion.ts. In lite mode,
 * `processEventBatch` transparently routes to `processEventBatchLite`
 * (inline SQLite write, no S3/Redis/worker involved).
 */

import { BaseError, jsonSchema } from "@peri-fuse/shared";
import {
  createIngestionAttribution,
  type IngestionHeaderMap,
  logger,
  processEventBatch,
} from "@peri-fuse/shared/src/server";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";

const app = new Hono<LiteServerEnv>();

const batchType = z.object({
  batch: z.array(z.unknown()).max(10_000),
  metadata: jsonSchema.nullish(),
});

app.post("/api/public/ingestion", authMiddleware, async (c) => {
  const auth = c.get("auth");

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ message: "Invalid request data", errors: ["Invalid JSON body"] }, 400);
  }

  const parsedSchema = batchType.safeParse(rawBody);
  if (!parsedSchema.success) {
    logger.info("Invalid request data", parsedSchema.error);
    return c.json(
      {
        message: "Invalid request data",
        errors: parsedSchema.error.issues.map((issue) => issue.message),
      },
      400,
    );
  }

  try {
    const headers: IngestionHeaderMap = Object.fromEntries(c.req.raw.headers.entries());

    const result = await processEventBatch(parsedSchema.data.batch, auth, {
      attribution: createIngestionAttribution({ headers, authCheck: auth }),
    });

    return c.json(result, 207);
  } catch (error: unknown) {
    if (error instanceof BaseError) {
      if (!error.isUserError()) {
        logger.error(error);
      }
      return c.json({ error: error.name, message: error.message }, error.httpCode as 400);
    }

    if (error instanceof z.ZodError) {
      logger.error(`Zod exception`, error.issues);
      return c.json({ message: "Invalid request data", error: error.issues }, 400);
    }

    logger.error("error_handling_ingestion_event", error);
    return c.json(
      {
        message: "Invalid request data",
        errors: [error instanceof Error ? error.message : "An unknown error occurred"],
      },
      500,
    );
  }
});

export default app;
