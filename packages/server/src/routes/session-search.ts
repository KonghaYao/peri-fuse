import { TelemetryQueryError } from "@peri-fuse/shared/src/server/adapters";
import { getSessionContext, searchSessions } from "@peri-fuse/shared/src/server/session-search";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, type LiteServerEnv } from "../auth";

const range = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("relative"),
    seconds: z
      .union([z.literal(3600), z.literal(21600), z.literal(86400), z.literal(604800)])
      .optional(),
  }),
  z.object({
    kind: z.literal("absolute"),
    fromTimestamp: z.string().datetime(),
    toTimestamp: z.string().datetime(),
  }),
]);
const search = z.object({
  query: z.string().max(10_000),
  timeRange: range.optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
const context = z.object({
  occurrenceId: z.string().min(1).max(200),
  sourceVersion: z.number().int().positive(),
  query: z.string().max(128).optional(),
  before: z.number().int().min(0).max(2).optional(),
  after: z.number().int().min(0).max(2).optional(),
  beforeCursor: z.string().max(1024).optional(),
  afterCursor: z.string().max(1024).optional(),
  blockCursor: z.string().max(1024).optional(),
  blockBeforeCursor: z.string().max(1024).optional(),
});
const app = new Hono<LiteServerEnv>();
function errorResponse(c: Context<LiteServerEnv>, error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "QUERY_TOO_SHORT")
    return c.json({ code, message: "Query must contain at least 3 characters" }, 400);
  if (code === "QUERY_TOO_LONG")
    return c.json({ code, message: "Query must not exceed 128 characters" }, 400);
  if (code === "INVALID_TIME_RANGE")
    return c.json({ code, message: "Invalid session search time range" }, 400);
  if (code === "CONTEXT_STALE") return c.json({ code, message: "Search result is stale" }, 409);
  if (code === "CONTEXT_UNAVAILABLE")
    return c.json({ code, message: "Context is unavailable" }, 404);
  if (code === "SEARCH_BUSY" || code === "SEARCH_TIMEOUT")
    return c.json({ code, message: "Search temporarily unavailable" }, 503);
  // The bounded search budget is propagated as an AbortSignal. The read pool
  // may reject with a plain AbortError when that signal wins the race before
  // it can wrap the cancellation as TelemetryQueryError(TIMEOUT).
  if (error instanceof Error && error.name === "AbortError")
    return c.json({ code: "SEARCH_TIMEOUT", message: "Search timed out" }, 503);
  if (error instanceof TelemetryQueryError) {
    if (error.code === "OVERLOADED")
      return c.json({ code: "SEARCH_BUSY", message: "Search temporarily unavailable" }, 503);
    if (error.code === "TIMEOUT" || error.name === "AbortError")
      return c.json({ code: "SEARCH_TIMEOUT", message: "Search timed out" }, 503);
    if (error.code === "UNAVAILABLE")
      return c.json({ code: "SEARCH_UNAVAILABLE", message: "Search index unavailable" }, 503);
  }
  if (error instanceof Error && /no such table: search_/i.test(error.message))
    return c.json({ code: "SEARCH_UNAVAILABLE", message: "Search index unavailable" }, 503);
  return c.json({ code: "SEARCH_FAILED", message: "Session search failed" }, 500);
}
app.post("/api/public/session-search", authMiddleware, async (c) => {
  const parsed = search.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ code: "INVALID_REQUEST", message: "Invalid session search request" }, 400);
  try {
    const result = await searchSessions(
      c.get("auth").scope.projectId,
      parsed.data,
      c.req.raw.signal,
    );
    return c.json(result);
  } catch (error) {
    return errorResponse(c, error);
  }
});
app.post("/api/public/session-search/context", authMiddleware, async (c) => {
  const parsed = context.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ code: "INVALID_REQUEST", message: "Invalid context request" }, 400);
  try {
    return c.json(
      await getSessionContext(c.get("auth").scope.projectId, parsed.data, c.req.raw.signal),
    );
  } catch (error) {
    return errorResponse(c, error);
  }
});
export default app;
