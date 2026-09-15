import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyStoredProjectCredentials } from "@/shared/lib/api";
import { clearProjectContext, setProjectContext } from "@/shared/store/project";
import { jsonResponse } from "@/test/query-test-helpers";

const sampleContext = {
  projectId: "proj-1",
  projectName: "Alpha",
  publicKey: "pk-test",
  secretKey: "sk-test",
};

describe("verifyStoredProjectCredentials", () => {
  afterEach(() => {
    clearProjectContext();
    vi.unstubAllGlobals();
  });

  it("returns false when no project is stored", async () => {
    expect(await verifyStoredProjectCredentials()).toBe(false);
  });

  it("returns true when stored credentials are accepted", async () => {
    setProjectContext(sampleContext);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: [], meta: { page: 1, limit: 1, totalItems: 0 } })),
    );

    expect(await verifyStoredProjectCredentials()).toBe(true);
    expect(localStorage.getItem("peri-fuse-project")).toContain("proj-1");
  });

  it("clears stale credentials on 401", async () => {
    setProjectContext(sampleContext);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Invalid credentials" }, { status: 401 })));

    expect(await verifyStoredProjectCredentials()).toBe(false);
    expect(localStorage.getItem("peri-fuse-project")).toBeNull();
  });
});
