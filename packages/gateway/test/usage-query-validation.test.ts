import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dailySpend } from "../src/db/schema.js";
import { getDb } from "../src/db.js";
import {
  type AdminTestHarness,
  createAdminTestHarness,
  PROJECT_A,
  PROJECT_B,
} from "./helpers/admin-test-harness.js";

describe("Gateway daily usage query validation", () => {
  let harness: AdminTestHarness;

  beforeAll(async () => {
    harness = await createAdminTestHarness();
    await getDb()
      .insert(dailySpend)
      .values([
        {
          id: "usage-a-old",
          projectId: PROJECT_A,
          apiKey: "usage-key-a",
          date: "2026-08-27",
          model: "model-a",
          provider: "provider-a",
          spend: 1,
        },
        {
          id: "usage-a-middle",
          projectId: PROJECT_A,
          apiKey: "usage-key-other",
          date: "2026-08-28",
          model: "model-other",
          provider: "provider-other",
          spend: 2,
        },
        {
          id: "usage-a-new",
          projectId: PROJECT_A,
          apiKey: "usage-key-a",
          date: "2026-08-29",
          model: "model-a",
          provider: "provider-a",
          spend: 3,
        },
        {
          id: "usage-b-newest",
          projectId: PROJECT_B,
          apiKey: "usage-key-b",
          date: "2026-08-30",
          model: "model-a",
          provider: "provider-a",
          spend: 4,
        },
      ]);
  });

  afterAll(async () => {
    await harness.close();
  });

  it("accepts only daily usage limits between 1 and 200", async () => {
    for (const limit of ["", "0", "-1", "1.5", "10junk", "abc", "201", "999999999999999999"]) {
      const response = await harness.request(
        "A",
        "GET",
        `/admin/usage/daily?limit=${encodeURIComponent(limit)}`,
      );
      expect(response.status, limit).toBe(400);
      expect(response.body, limit).toEqual({
        error: { message: "limit must be an integer between 1 and 200" },
      });
    }

    expect((await harness.request("A", "GET", "/admin/usage/daily?limit=1")).status).toBe(200);
    expect((await harness.request("A", "GET", "/admin/usage/daily?limit=200")).status).toBe(200);
  });

  it("rejects a nonexistent UTC calendar date", async () => {
    const response = await harness.request("A", "GET", "/admin/usage/daily?startDate=2023-02-29");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { message: "startDate must be a valid date in YYYY-MM-DD format" },
    });
  });

  it("accepts only strict UTC dates and ordered ranges", async () => {
    for (const value of [
      "",
      "2026-13-01",
      "2026-01-32",
      "2026-8-01",
      "2026-01-1",
      "2026-08-29T00:00:00.000Z",
    ]) {
      const response = await harness.request(
        "A",
        "GET",
        `/admin/usage/daily?endDate=${encodeURIComponent(value)}`,
      );
      expect(response.status, value).toBe(400);
      expect(response.body, value).toEqual({
        error: { message: "endDate must be a valid date in YYYY-MM-DD format" },
      });
    }

    const reversed = await harness.request(
      "A",
      "GET",
      "/admin/usage/daily?startDate=2026-08-30&endDate=2026-08-29",
    );
    expect(reversed.status).toBe(400);
    expect(reversed.body).toEqual({
      error: { message: "startDate must be on or before endDate" },
    });
    expect(
      (await harness.request("A", "GET", "/admin/usage/daily?startDate=2024-02-29")).status,
    ).toBe(200);
  });

  it("preserves filtering, ordering, project isolation, and response shape", async () => {
    const limited = await harness.request("A", "GET", "/admin/usage/daily?limit=2");
    expect(limited.status).toBe(200);
    expect(Object.keys(limited.body)).toEqual(["data"]);
    expect(limited.body.data.map((row: { id: string }) => row.id)).toEqual([
      "usage-a-new",
      "usage-a-middle",
    ]);
    expect(JSON.stringify(limited.body)).not.toContain("usage-b-newest");

    const filtered = await harness.request(
      "A",
      "GET",
      "/admin/usage/daily?startDate=2026-08-28&endDate=2026-08-29&apiKey=usage-key-a&model=model-a&provider=provider-a",
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.map((row: { id: string }) => row.id)).toEqual(["usage-a-new"]);
  });
});
