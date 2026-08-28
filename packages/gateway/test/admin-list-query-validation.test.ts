import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, errorLog, spendLog } from "../src/db/schema.js";
import { getDb } from "../src/db.js";
import {
  type AdminTestHarness,
  createAdminTestHarness,
  PROJECT_A,
  PROJECT_B,
} from "./helpers/admin-test-harness.js";

describe("Gateway Admin list query validation", () => {
  let harness: AdminTestHarness;

  beforeAll(async () => {
    harness = await createAdminTestHarness();
    const db = getDb();
    await db.insert(spendLog).values([
      {
        id: "request-a-old",
        projectId: PROJECT_A,
        callType: "completion",
        apiKey: "request-key-a",
        startTime: "2026-08-29T00:00:00.000Z",
        endTime: "2026-08-29T00:00:01.000Z",
        model: "request-model-a",
        provider: "request-provider-a",
        status: "success",
        sessionId: "request-session-a",
      },
      {
        id: "request-a-new",
        projectId: PROJECT_A,
        callType: "completion",
        apiKey: "request-key-a",
        startTime: "2026-08-29T01:00:00.000Z",
        endTime: "2026-08-29T01:00:01.000Z",
        model: "request-model-a",
        provider: "request-provider-a",
        status: "success",
        sessionId: "request-session-a",
      },
      {
        id: "request-b-newest",
        projectId: PROJECT_B,
        callType: "completion",
        apiKey: "request-key-b",
        startTime: "2026-08-29T02:00:00.000Z",
        endTime: "2026-08-29T02:00:01.000Z",
        model: "request-model-a",
        provider: "request-provider-a",
        status: "success",
      },
    ]);
    await db.insert(errorLog).values([
      {
        id: "error-a-old",
        projectId: PROJECT_A,
        startTime: "2026-08-29T00:00:00.000Z",
        endTime: "2026-08-29T00:00:01.000Z",
        modelGroup: "error-group-a",
        exceptionType: "ErrorA",
      },
      {
        id: "error-a-new",
        projectId: PROJECT_A,
        startTime: "2026-08-29T01:00:00.000Z",
        endTime: "2026-08-29T01:00:01.000Z",
        modelGroup: "error-group-a",
        exceptionType: "ErrorA",
      },
      {
        id: "error-b-newest",
        projectId: PROJECT_B,
        startTime: "2026-08-29T02:00:00.000Z",
        endTime: "2026-08-29T02:00:01.000Z",
        modelGroup: "error-group-a",
        exceptionType: "ErrorA",
      },
    ]);
    await db.insert(auditLog).values([
      {
        id: "audit-a-old",
        projectId: PROJECT_A,
        action: "update",
        tableName: "Provider",
        objectId: "provider-a-old",
        createdAt: "2026-08-29T00:00:00.000Z",
      },
      {
        id: "audit-a-new",
        projectId: PROJECT_A,
        action: "update",
        tableName: "Provider",
        objectId: "provider-a-new",
        createdAt: "2026-08-29T01:00:00.000Z",
      },
      {
        id: "audit-b-newest",
        projectId: PROJECT_B,
        action: "update",
        tableName: "Provider",
        objectId: "provider-b-newest",
        createdAt: "2026-08-29T02:00:00.000Z",
      },
    ]);
  });

  afterAll(async () => {
    await harness.close();
  });

  it("uses strict pagination boundaries across every Admin log list", async () => {
    const paths = ["/admin/logs/requests", "/admin/logs/errors", "/admin/audit"];
    const invalidQueries = [
      ["limit=", "limit must be an integer between 1 and 200"],
      ["limit=0", "limit must be an integer between 1 and 200"],
      ["limit=01", "limit must be an integer between 1 and 200"],
      ["limit=-1", "limit must be an integer between 1 and 200"],
      ["limit=1.5", "limit must be an integer between 1 and 200"],
      ["limit=10junk", "limit must be an integer between 1 and 200"],
      ["limit=abc", "limit must be an integer between 1 and 200"],
      ["limit=201", "limit must be an integer between 1 and 200"],
      ["offset=", "offset must be a non-negative integer"],
      ["offset=-1", "offset must be a non-negative integer"],
      ["offset=00", "offset must be a non-negative integer"],
      ["offset=1.5", "offset must be a non-negative integer"],
      ["offset=10junk", "offset must be a non-negative integer"],
      ["offset=9007199254740992", "offset must be a non-negative integer"],
    ] as const;

    for (const path of paths) {
      for (const [query, message] of invalidQueries) {
        const response = await harness.request("A", "GET", `${path}?${query}`);
        expect(response.status, `${path}?${query}`).toBe(400);
        expect(response.body, `${path}?${query}`).toEqual({ error: { message } });
      }
    }
  });

  it("accepts only canonical UTC timestamp boundaries on every list", async () => {
    const paths = ["/admin/logs/requests", "/admin/logs/errors", "/admin/audit"];
    for (const path of paths) {
      const invalidStart = await harness.request("A", "GET", `${path}?startDate=2026-08-29`);
      expect(invalidStart.status, path).toBe(400);
      expect(invalidStart.body, path).toEqual({
        error: {
          message: "startDate must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)",
        },
      });

      const invalidEnd = await harness.request(
        "A",
        "GET",
        `${path}?endDate=${encodeURIComponent("2026-08-29T01:00:00.000+00:00")}`,
      );
      expect(invalidEnd.status, path).toBe(400);
      expect(invalidEnd.body, path).toEqual({
        error: {
          message: "endDate must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)",
        },
      });

      const reversed = await harness.request(
        "A",
        "GET",
        `${path}?startDate=2026-08-29T02:00:00.000Z&endDate=2026-08-29T01:00:00.000Z`,
      );
      expect(reversed.status, path).toBe(400);
      expect(reversed.body, path).toEqual({
        error: { message: "startDate must be on or before endDate" },
      });
    }

    for (const value of [
      "",
      "2026-08-29T01:00:00Z",
      "2026-08-29T01:00:00.000",
      "2026-02-30T01:00:00.000Z",
    ]) {
      const response = await harness.request(
        "A",
        "GET",
        `/admin/logs/requests?startDate=${encodeURIComponent(value)}`,
      );
      expect(response.status, value).toBe(400);
    }
  });

  it("returns validation errors in limit, offset, start, end, range order", async () => {
    const cases = [
      [
        "limit=-1&offset=-1&startDate=bad&endDate=bad",
        "limit must be an integer between 1 and 200",
      ],
      ["limit=1&offset=-1&startDate=bad&endDate=bad", "offset must be a non-negative integer"],
      [
        "limit=1&offset=0&startDate=bad&endDate=bad",
        "startDate must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)",
      ],
      [
        "limit=1&offset=0&startDate=2026-08-29T00:00:00.000Z&endDate=bad",
        "endDate must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)",
      ],
      [
        "limit=1&offset=0&startDate=2026-08-29T02:00:00.000Z&endDate=2026-08-29T01:00:00.000Z",
        "startDate must be on or before endDate",
      ],
    ] as const;

    for (const [query, message] of cases) {
      const response = await harness.request("A", "GET", `/admin/logs/requests?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body, query).toEqual({ error: { message } });
    }
  });

  it("preserves filters, pagination, response shapes, and project isolation", async () => {
    const requests = await harness.request(
      "A",
      "GET",
      "/admin/logs/requests?limit=1&offset=1&apiKey=request-key-a&model=request-model-a&provider=request-provider-a&status=success&sessionId=request-session-a&startDate=2026-08-29T00:00:00.000Z&endDate=2026-08-29T01:00:00.000Z",
    );
    expect(requests.status).toBe(200);
    expect(Object.keys(requests.body)).toEqual(["data", "total", "limit", "offset"]);
    expect(requests.body.total).toBe(2);
    expect(requests.body.limit).toBe(1);
    expect(requests.body.offset).toBe(1);
    expect(requests.body.data.map((row: { id: string }) => row.id)).toEqual(["request-a-old"]);
    expect(JSON.stringify(requests.body)).not.toContain("request-b-newest");

    const errors = await harness.request(
      "A",
      "GET",
      "/admin/logs/errors?limit=1&offset=0&modelGroup=error-group-a&exceptionType=ErrorA",
    );
    expect(errors.status).toBe(200);
    expect(Object.keys(errors.body)).toEqual(["data", "total"]);
    expect(errors.body.total).toBe(2);
    expect(errors.body.data.map((row: { id: string }) => row.id)).toEqual(["error-a-new"]);
    expect(JSON.stringify(errors.body)).not.toContain("error-b-newest");

    const audits = await harness.request(
      "A",
      "GET",
      "/admin/audit?limit=1&offset=1&tableName=Provider&action=update",
    );
    expect(audits.status).toBe(200);
    expect(Object.keys(audits.body)).toEqual(["data", "total"]);
    expect(audits.body.total).toBe(2);
    expect(audits.body.data.map((row: { id: string }) => row.id)).toEqual(["audit-a-old"]);
    expect(JSON.stringify(audits.body)).not.toContain("audit-b-newest");

    const defaults = await harness.request("A", "GET", "/admin/logs/requests");
    expect(defaults.body.limit).toBe(50);
    expect(defaults.body.offset).toBe(0);
    expect((await harness.request("A", "GET", "/admin/logs/requests?limit=200")).status).toBe(200);
  });
});
