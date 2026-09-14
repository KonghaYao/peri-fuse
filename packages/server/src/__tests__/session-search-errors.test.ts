import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchSessions, getSessionContext } = vi.hoisted(() => ({
  searchSessions: vi.fn(),
  getSessionContext: vi.fn(),
}));

vi.mock("@peri-fuse/shared/src/server/session-search", () => ({
  searchSessions,
  getSessionContext,
}));

vi.mock("../auth", async () => {
  const { createMiddleware } = await import("hono/factory");
  return {
    authMiddleware: createMiddleware(async (c, next) => {
      c.set("auth", {
        validKey: true,
        scope: { projectId: "test-project" },
      });
      await next();
    }),
  };
});

import sessionSearchRoutes from "../routes/session-search";

const app = new Hono();
app.route("/", sessionSearchRoutes);

const requestBody = {
  query: "wide query",
  timeRange: { kind: "relative", seconds: 3600 },
};

async function searchRequest() {
  return app.request("/api/public/session-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
}

describe("session search error classification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("maps a plain AbortError from the bounded search budget to a timeout", async () => {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    searchSessions.mockRejectedValueOnce(error);

    const response = await searchRequest();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "SEARCH_TIMEOUT",
      message: "Search timed out",
    });
  });

  it("sanitizes unexpected search failures as SEARCH_FAILED", async () => {
    searchSessions.mockRejectedValueOnce(new Error("secret database details"));

    const response = await searchRequest();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "SEARCH_FAILED",
      message: "Session search failed",
    });
  });

  it("returns a client error for an invalid time range", async () => {
    searchSessions.mockRejectedValueOnce(new Error("INVALID_TIME_RANGE"));

    const response = await searchRequest();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_TIME_RANGE",
      message: "Invalid session search time range",
    });
  });
});
