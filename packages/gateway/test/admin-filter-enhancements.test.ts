import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dailySpend, errorLog, modelDeployment, provider, spendLog } from "../src/db/schema.js";
import { getDb } from "../src/db.js";
import {
  type AdminTestHarness,
  createAdminTestHarness,
  PROJECT_A,
  PROJECT_B,
} from "./helpers/admin-test-harness.js";

describe("Gateway troubleshooting filters", () => {
  let harness: AdminTestHarness;

  function replaceFilter(filters: string, name: string, value: string) {
    const search = new URLSearchParams(filters);
    search.set(name, value);
    return search.toString();
  }

  beforeAll(async () => {
    harness = await createAdminTestHarness();
    const db = getDb();
    for (const [suffix, projectId] of [
      ["a", PROJECT_A],
      ["b", PROJECT_B],
    ]) {
      await db.insert(provider).values({
        id: `provider-${suffix}`,
        projectId,
        name: "shared-provider",
        type: "openai",
        baseUrl: "https://example.test",
        status: "cooldown",
        isEnabled: false,
      });
      await db.insert(modelDeployment).values({
        id: `deployment-${suffix}`,
        projectId,
        providerId: `provider-${suffix}`,
        modelName: "alias",
        providerModel: "upstream",
        isEnabled: false,
      });
      for (const [index, day] of ["28", "29", "30"].entries()) {
        const startTime = `2026-09-${day}T12:00:00.000Z`;
        const matching = index !== 2;
        await db.insert(spendLog).values({
          id: `request-${suffix}-${day}`,
          projectId,
          callType: "completion",
          startTime,
          endTime: startTime,
          model: matching ? "upstream" : "other",
          provider: "openai",
          apiKey: "pk-shared",
          status: "failure",
          sessionId: "session",
          requestDurationMs: matching ? 2000 : 100,
        });
        await db.insert(errorLog).values({
          id: `error-${suffix}-${day}`,
          projectId,
          startTime,
          endTime: startTime,
          modelGroup: "alias",
          providerModel: "upstream",
          modelId: "deployment",
          apiBase: "https://example.test",
          statusCode: matching ? "429" : "500",
          exceptionType: "RateLimitError",
          exceptionString: "slow down",
        });
        await db.insert(dailySpend).values({
          id: `daily-${suffix}-${day}`,
          projectId,
          date: `2026-09-${day}`,
          apiKey: "pk-shared",
          model: matching ? "upstream" : "other",
          provider: "openai",
          spend: matching ? 2 : 100,
          apiRequests: 1,
        });
      }
    }
    await db.insert(provider).values({
      id: "provider-other",
      projectId: PROJECT_A,
      name: "other",
      type: "anthropic",
      baseUrl: "https://other.test",
    });
    await db.insert(modelDeployment).values({
      id: "deployment-other",
      projectId: PROJECT_A,
      providerId: "provider-other",
      modelName: "other",
      providerModel: "other",
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it("filters requests before pagination and counts only the authenticated project", async () => {
    const filters =
      "model=upstream&provider=openai&apiKey=pk-shared&status=failure&sessionId=session&minDurationMs=2000&startDate=2026-09-28T00:00:00.000Z&endDate=2026-09-29T23:59:59.999Z";
    const response = await harness.request(
      "A",
      "GET",
      `/admin/logs/requests?${filters}&limit=1&offset=1&projectId=${PROJECT_B}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.data.map((row: { id: string }) => row.id)).toEqual(["request-a-28"]);
    for (const [name, value] of [
      ["apiKey", "missing"],
      ["provider", "missing"],
      ["model", "missing"],
      ["sessionId", "missing"],
      ["status", "success"],
      ["minDurationMs", "2001"],
    ]) {
      const empty = await harness.request(
        "A",
        "GET",
        `/admin/logs/requests?${replaceFilter(filters, name, value)}`,
      );
      expect(empty.body.total, name).toBe(0);
    }
  });

  it("filters HTTP errors before pagination using real ErrorLog fields", async () => {
    const filters =
      "statusCode=429&modelGroup=alias&providerModel=upstream&modelId=deployment&apiBase=https%3A%2F%2Fexample.test&exceptionType=RateLimitError&startDate=2026-09-28T00:00:00.000Z&endDate=2026-09-29T23:59:59.999Z";
    const response = await harness.request(
      "A",
      "GET",
      `/admin/logs/errors?${filters}&limit=1&offset=1`,
    );
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(2);
    expect(response.body.data.map((row: { id: string }) => row.id)).toEqual(["error-a-28"]);
    expect(response.body.data[0].exceptionString).toBe("slow down");
    for (const name of [
      "statusCode",
      "modelGroup",
      "providerModel",
      "modelId",
      "apiBase",
      "exceptionType",
    ]) {
      const value = name === "statusCode" ? "404" : "missing";
      const empty = await harness.request(
        "A",
        "GET",
        `/admin/logs/errors?${replaceFilter(filters, name, value)}`,
      );
      expect(empty.body.total, name).toBe(0);
    }
    const other = await harness.request("B", "GET", `/admin/logs/errors?${filters}`);
    expect(other.body.data.every((row: { projectId: string }) => row.projectId === PROJECT_B)).toBe(
      true,
    );
    for (const statusCode of ["", "99", "600", "429x", "4xx", "-1"]) {
      expect(
        (await harness.request("A", "GET", `/admin/logs/errors?statusCode=${statusCode}`)).status,
      ).toBe(400);
    }
  });

  it("applies identical model/provider/key/date filters to all usage views", async () => {
    const filters =
      "model=upstream&provider=openai&apiKey=pk-shared&startDate=2026-09-28&endDate=2026-09-29";
    for (const endpoint of ["summary", "daily", "by-model", "by-provider", "by-key"]) {
      const response = await harness.request("A", "GET", `/admin/usage/${endpoint}?${filters}`);
      expect(response.status, endpoint).toBe(200);
      if (endpoint === "summary") expect(response.body.totalSpend).toBe(4);
      else if (endpoint === "daily")
        expect(response.body.data.map((row: { id: string }) => row.id)).toEqual([
          "daily-a-29",
          "daily-a-28",
        ]);
      else expect(response.body.data[0].totalSpend, endpoint).toBe(4);
      for (const name of ["model", "provider", "apiKey"]) {
        const empty = await harness.request(
          "A",
          "GET",
          `/admin/usage/${endpoint}?${replaceFilter(filters, name, "missing")}`,
        );
        if (endpoint === "summary") expect(empty.body.totalSpend, name).toBe(0);
        else expect(empty.body.data, name).toEqual([]);
      }
      expect(
        (await harness.request("A", "GET", `/admin/usage/${endpoint}?startDate=2026-02-30`)).status,
      ).toBe(400);
      expect(
        (
          await harness.request(
            "A",
            "GET",
            `/admin/usage/${endpoint}?startDate=2026-09-30&endDate=2026-09-28`,
          )
        ).status,
      ).toBe(400);
    }
    const limited = await harness.request("A", "GET", `/admin/usage/daily?${filters}&limit=1`);
    expect(limited.body.data[0].id).toBe("daily-a-29");
  });

  it("filters deployments and providers on the server without widening project scope", async () => {
    const providers = await harness.request(
      "A",
      "GET",
      "/admin/providers?name=shared-provider&type=openai&status=cooldown&isEnabled=false",
    );
    expect(providers.body.data.map((row: { id: string }) => row.id)).toEqual(["provider-a"]);
    const models = await harness.request(
      "A",
      "GET",
      "/admin/models?modelName=alias&providerModel=upstream&providerId=provider-a&isEnabled=false",
    );
    expect(models.body.data.map((row: { id: string }) => row.id)).toEqual(["deployment-a"]);
    expect(
      (await harness.request("A", "GET", "/admin/models?providerId=provider-b")).body.data,
    ).toEqual([]);
    for (const endpoint of ["models", "providers"]) {
      expect(
        (await harness.request("A", "GET", `/admin/${endpoint}?isEnabled=invalid`)).status,
      ).toBe(400);
      expect((await harness.request("A", "GET", `/admin/${endpoint}`)).body.data).toHaveLength(2);
    }
    for (const name of ["name", "type", "status"]) {
      expect(
        (await harness.request("A", "GET", `/admin/providers?${name}=missing`)).body.data,
      ).toEqual([]);
    }
    for (const name of ["modelName", "providerModel"]) {
      expect(
        (await harness.request("A", "GET", `/admin/models?${name}=missing`)).body.data,
      ).toEqual([]);
    }
  });

  it("keeps legacy no-filter log responses and default pagination", async () => {
    for (const endpoint of ["requests", "errors"]) {
      const response = await harness.request("A", "GET", `/admin/logs/${endpoint}`);
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(3);
      expect(response.body.data).toHaveLength(3);
    }
  });

  it("rejects invalid request durations and preserves inclusive date filtering", async () => {
    for (const value of ["", "NaN", "-1", "1.5", "1e3", "9007199254740992"]) {
      expect(
        (await harness.request("A", "GET", `/admin/logs/requests?minDurationMs=${value}`)).status,
      ).toBe(400);
    }
    for (const endpoint of ["requests", "errors"]) {
      const exact = await harness.request(
        "A",
        "GET",
        `/admin/logs/${endpoint}?startDate=2026-09-29T12:00:00.000Z&endDate=2026-09-29T12:00:00.000Z`,
      );
      expect(exact.body.total).toBe(1);
      const reversed = await harness.request(
        "A",
        "GET",
        `/admin/logs/${endpoint}?startDate=2026-09-30T00:00:00.000Z&endDate=2026-09-28T00:00:00.000Z`,
      );
      expect(reversed.status).toBe(400);
    }
  });
});
