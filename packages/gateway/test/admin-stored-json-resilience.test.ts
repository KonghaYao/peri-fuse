import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, errorLog, spendLog } from "../src/db/schema.js";
import { getDb } from "../src/db.js";
import {
  type AdminTestHarness,
  createAdminTestHarness,
  PROJECT_A,
  PROJECT_B,
} from "./helpers/admin-test-harness.js";

const BROKEN_JSON = "do-not-leak::broken-json";

function rowById<T extends { id: string }>(rows: T[], id: string): T {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`Missing test row ${id}`);
  return row;
}

describe("Gateway Admin stored JSON resilience", () => {
  let harness: AdminTestHarness;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    harness = await createAdminTestHarness();
    const db = getDb();

    await db.insert(spendLog).values([
      {
        id: "spend-a-broken-json",
        projectId: PROJECT_A,
        callType: "completion",
        apiKey: "key-a",
        startTime: "2026-08-29T03:00:00.000Z",
        endTime: "2026-08-29T03:00:01.000Z",
        model: "model-a",
        metadata: `${BROKEN_JSON}:metadata`,
        requestTags: `${BROKEN_JSON}:requestTags`,
        messages: `${BROKEN_JSON}:messages`,
        response: `${BROKEN_JSON}:response`,
      },
      {
        id: "spend-a-healthy-json",
        projectId: PROJECT_A,
        callType: "completion",
        apiKey: "key-a",
        startTime: "2026-08-29T02:00:00.000Z",
        endTime: "2026-08-29T02:00:01.000Z",
        model: "model-a",
        metadata: JSON.stringify({ source: "healthy" }),
        requestTags: JSON.stringify(["healthy"]),
        messages: null,
        response: JSON.stringify({ ok: true }),
      },
      {
        id: "spend-b-broken-json",
        projectId: PROJECT_B,
        callType: "completion",
        apiKey: "key-b",
        startTime: "2026-08-29T04:00:00.000Z",
        endTime: "2026-08-29T04:00:01.000Z",
        model: "model-b",
        metadata: `${BROKEN_JSON}:project-b`,
      },
    ]);

    await db.insert(errorLog).values([
      {
        id: "error-a-broken-json",
        projectId: PROJECT_A,
        startTime: "2026-08-29T03:00:00.000Z",
        endTime: "2026-08-29T03:00:01.000Z",
        requestKwargs: `${BROKEN_JSON}:requestKwargs`,
      },
      {
        id: "error-a-healthy-json",
        projectId: PROJECT_A,
        startTime: "2026-08-29T02:00:00.000Z",
        endTime: "2026-08-29T02:00:01.000Z",
        requestKwargs: JSON.stringify({ stream: true }),
      },
      {
        id: "error-b-broken-json",
        projectId: PROJECT_B,
        startTime: "2026-08-29T04:00:00.000Z",
        endTime: "2026-08-29T04:00:01.000Z",
        requestKwargs: `${BROKEN_JSON}:project-b`,
      },
    ]);

    await db.insert(auditLog).values([
      {
        id: "audit-a-broken-json",
        projectId: PROJECT_A,
        action: "update",
        tableName: "Provider",
        objectId: "provider-a",
        beforeValue: `${BROKEN_JSON}:beforeValue`,
        afterValue: `${BROKEN_JSON}:afterValue`,
        createdAt: "2026-08-29T03:00:00.000Z",
      },
      {
        id: "audit-a-healthy-json",
        projectId: PROJECT_A,
        action: "update",
        tableName: "Provider",
        objectId: "provider-a",
        beforeValue: null,
        afterValue: JSON.stringify({ name: "healthy" }),
        createdAt: "2026-08-29T02:00:00.000Z",
      },
      {
        id: "audit-b-broken-json",
        projectId: PROJECT_B,
        action: "update",
        tableName: "Provider",
        objectId: "provider-b",
        beforeValue: `${BROKEN_JSON}:project-b`,
        createdAt: "2026-08-29T04:00:00.000Z",
      },
    ]);
  });

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("keeps request list and detail available when all four JSON fields are corrupt", async () => {
    const list = await harness.request("A", "GET", "/admin/logs/requests");
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    const broken = rowById(list.body.data, "spend-a-broken-json");
    expect(broken).toMatchObject({ metadata: {}, requestTags: [], messages: null, response: null });
    expect(rowById(list.body.data, "spend-a-healthy-json")).toMatchObject({
      metadata: { source: "healthy" },
      requestTags: ["healthy"],
      messages: null,
      response: { ok: true },
    });
    expect(JSON.stringify(list.body)).not.toContain(BROKEN_JSON);
    expect(warn.mock.calls).toEqual(
      ["metadata", "requestTags", "messages", "response"].map((field) => [
        "[peri-gateway] Invalid stored JSON",
        { projectId: PROJECT_A, entity: "SpendLog", id: "spend-a-broken-json", field },
      ]),
    );

    warn.mockClear();
    const detail = await harness.request("A", "GET", "/admin/logs/requests/spend-a-broken-json");
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      metadata: {},
      requestTags: [],
      messages: null,
      response: null,
    });
    expect(JSON.stringify(detail.body)).not.toContain(BROKEN_JSON);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("keeps error lists available when request kwargs are corrupt", async () => {
    const response = await harness.request("A", "GET", "/admin/logs/errors");
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(rowById(response.body.data, "error-a-broken-json").requestKwargs).toEqual({});
    expect(rowById(response.body.data, "error-a-healthy-json").requestKwargs).toEqual({
      stream: true,
    });
    expect(JSON.stringify(response.body)).not.toContain(BROKEN_JSON);
    expect(warn.mock.calls).toEqual([
      [
        "[peri-gateway] Invalid stored JSON",
        {
          projectId: PROJECT_A,
          entity: "ErrorLog",
          id: "error-a-broken-json",
          field: "requestKwargs",
        },
      ],
    ]);
  });

  it("keeps audit lists available and leaves database nulls silent", async () => {
    const response = await harness.request("A", "GET", "/admin/audit");
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(rowById(response.body.data, "audit-a-broken-json")).toMatchObject({
      beforeValue: null,
      afterValue: null,
    });
    expect(rowById(response.body.data, "audit-a-healthy-json")).toMatchObject({
      beforeValue: null,
      afterValue: { name: "healthy" },
    });
    expect(JSON.stringify(response.body)).not.toContain(BROKEN_JSON);
    expect(warn.mock.calls).toEqual(
      ["beforeValue", "afterValue"].map((field) => [
        "[peri-gateway] Invalid stored JSON",
        { projectId: PROJECT_A, entity: "AuditLog", id: "audit-a-broken-json", field },
      ]),
    );
  });

  it("does not parse or warn about corrupt rows from another project", async () => {
    const [requests, errors, audits] = await Promise.all([
      harness.request("A", "GET", "/admin/logs/requests"),
      harness.request("A", "GET", "/admin/logs/errors"),
      harness.request("A", "GET", "/admin/audit"),
    ]);
    expect(JSON.stringify([requests.body, errors.body, audits.body])).not.toContain("project-b");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PROJECT_B);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("-b-broken-json");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(BROKEN_JSON);
  });
});
