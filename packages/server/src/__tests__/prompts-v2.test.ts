/**
 * v2 prompts public API integration tests.
 *
 * Official semantics covered: server-assigned versions (max+1), `latest`
 * label management, project-wide label uniqueness, version selection
 * (version XOR label, default "production"), the `resolve` dependency switch
 * with resolutionGraph, PATCH newLabels whole-array replacement, type
 * mismatch 400, DELETE-all 204, and project isolation.
 *
 * The test app is assembled locally (route + error mapping) because app.ts
 * mounts v2 routes in T6 and its SPA fallback would shadow GETs otherwise.
 * GETs are response-cached (2s, key = projectId|path|query), so writes are
 * followed by clearResponseCache() before reads of the same URL.
 */
import { randomUUID } from "node:crypto";
import { BaseError, LangfuseNotFoundError } from "@peri-fuse/shared";
import { prisma } from "@peri-fuse/shared/src/db";
import { promptDependencies } from "@peri-fuse/shared/src/db/schema/index.js";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import type { LiteServerEnv } from "../auth";
import { clearResponseCache } from "../response-cache";
import promptsV2Routes from "../routes/prompts-v2";
import { basicAuth } from "./helpers";
import { createSecondProject, type SecondProject } from "./second-project";
import { TEST_PROJECT_ID } from "./test-db-paths";

// ---------------------------------------------------------------------------
// Local app assembly (see header comment)
// ---------------------------------------------------------------------------

function makeApp(): Hono<LiteServerEnv> {
  const app = new Hono<LiteServerEnv>();
  app.onError((err, c) => {
    if (err instanceof LangfuseNotFoundError) return c.json({ message: err.message }, 404);
    if (err instanceof BaseError) {
      return c.json({ error: err.name, message: err.message }, err.httpCode as 500);
    }
    return c.json({ message: "Internal Server Error" }, 500);
  });
  app.route("/", promptsV2Routes);
  return app;
}

let app: Hono<LiteServerEnv> | null = null;
function getApp(): Hono<LiteServerEnv> {
  if (!app) app = makeApp();
  return app;
}

interface ApiResult<T = any> {
  status: number;
  body: T;
}

async function req<T = any>(
  method: string,
  path: string,
  body?: unknown,
  auth: string = basicAuth(),
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Authorization: auth };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await getApp().request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const apiGet = (p: string, a?: string) => req("GET", p, undefined, a);
const apiPost = (p: string, b: unknown, a?: string) => req("POST", p, b, a);
const apiPatch = (p: string, b: unknown) => req("PATCH", p, b);
const apiDelete = (p: string, a?: string) => req("DELETE", p, undefined, a);

const pname = (prefix: string) => `${prefix}-${randomUUID()}`;
const V2 = "/api/public/v2/prompts";

describe("v2 prompts public API", () => {
  let second: SecondProject;

  beforeAll(async () => {
    second = await createSecondProject();
  });

  it("creates text/chat prompts with server-assigned versions and latest label", async () => {
    const name = pname("basic");
    const r1 = await apiPost(V2, {
      name,
      prompt: "hello v1",
      type: "text",
      labels: ["production"],
      tags: ["tag-a"],
      config: { model: "m" },
      commitMessage: "first",
    });
    expect(r1.status).toBe(200);
    expect(r1.body.version).toBe(1);
    expect(r1.body.name).toBe(name);
    expect(r1.body.type).toBe("text");
    expect(r1.body.prompt).toBe("hello v1");
    expect(r1.body.config).toEqual({ model: "m" });
    expect(r1.body.labels).toEqual(expect.arrayContaining(["production", "latest"]));
    expect(r1.body.tags).toEqual(["tag-a"]);
    expect(r1.body.commitMessage).toBe("first");
    expect(r1.body.isActive).toBe(true);
    expect(r1.body.resolutionGraph).toBeNull();
    expect(typeof r1.body.createdAt).toBe("string");
    expect(typeof r1.body.updatedAt).toBe("string");

    // Same name → version increments; type defaults to "text".
    const r2 = await apiPost(V2, { name, prompt: "hello v2" });
    expect(r2.status).toBe(200);
    expect(r2.body.version).toBe(2);
    expect(r2.body.type).toBe("text");
    expect(r2.body.isActive).toBe(false);

    const r3 = await apiPost(V2, {
      name: pname("chat"),
      prompt: [{ role: "user", content: "hi" }],
      type: "chat",
    });
    expect(r3.status).toBe(200);
    expect(r3.body.type).toBe("chat");
    expect(r3.body.prompt).toEqual([{ role: "user", content: "hi" }]);
  });

  it("keeps the latest label on the newest version only", async () => {
    const name = pname("latest");
    await apiPost(V2, { name, prompt: "v1" });
    clearResponseCache();
    const v1 = await apiGet(`${V2}/${name}?version=1`);
    expect(v1.body.labels).toEqual(["latest"]);

    await apiPost(V2, { name, prompt: "v2" });
    clearResponseCache();
    const v1b = await apiGet(`${V2}/${name}?version=1`);
    const v2 = await apiGet(`${V2}/${name}?version=2`);
    expect(v1b.body.labels).toEqual([]);
    expect(v2.body.labels).toEqual(["latest"]);
  });

  it("claims labels project-wide on create", async () => {
    const a = pname("claim-a");
    const b = pname("claim-b");
    await apiPost(V2, { name: a, prompt: "a1", labels: ["shared"] });
    const b1 = await apiPost(V2, { name: b, prompt: "b1", labels: ["shared"] });
    expect(b1.status).toBe(200);
    clearResponseCache();
    const a1 = await apiGet(`${V2}/${a}?version=1`);
    expect(a1.body.labels).toEqual([]); // "shared" (and "latest") moved away
    const b1g = await apiGet(`${V2}/${b}?version=1`);
    expect(b1g.body.labels).toEqual(expect.arrayContaining(["shared", "latest"]));
  });

  it("rejects a same-name create with a different type (400)", async () => {
    const name = pname("type");
    await apiPost(V2, { name, prompt: "text v1" });
    const res = await apiPost(V2, {
      name,
      prompt: [{ role: "user", content: "x" }],
      type: "chat",
    });
    expect(res.status).toBe(400);
  });

  it("selects versions by version/label and rejects specifying both (400)", async () => {
    const name = pname("select");
    await apiPost(V2, { name, prompt: "v1", labels: ["production"] });
    await apiPost(V2, { name, prompt: "v2", labels: ["staging"] });
    clearResponseCache();

    // Default selection: label "production".
    const def = await apiGet(`${V2}/${name}`);
    expect(def.status).toBe(200);
    expect(def.body.version).toBe(1);
    expect(def.body.prompt).toBe("v1");

    const byLabel = await apiGet(`${V2}/${name}?label=staging`);
    expect(byLabel.status).toBe(200);
    expect(byLabel.body.version).toBe(2);

    const byVersion = await apiGet(`${V2}/${name}?version=2`);
    expect(byVersion.status).toBe(200);
    expect(byVersion.body.version).toBe(2);

    const both = await apiGet(`${V2}/${name}?version=1&label=production`);
    expect(both.status).toBe(400);
    expect(both.body.message).toBe("Cannot specify both");

    const missing = pname("nope");
    const nf = await apiGet(`${V2}/${missing}`);
    expect(nf.status).toBe(404);
    expect(nf.body.message).toBe(`Prompt not found: '${missing}' with label 'production'`);

    const nfLabel = await apiGet(`${V2}/${name}?label=nope`);
    expect(nfLabel.status).toBe(404);
    expect(nfLabel.body.message).toBe(`Prompt not found: '${name}' with label 'nope'`);

    const nfVersion = await apiGet(`${V2}/${name}?version=99`);
    expect(nfVersion.status).toBe(404);
    expect(nfVersion.body.message).toBe(`Prompt not found: '${name}' with version '99'`);
  });

  it("patches newLabels with whole-array replacement", async () => {
    const name = pname("patch");
    await apiPost(V2, { name, prompt: "v1", labels: ["a", "b"] });
    await apiPost(V2, { name, prompt: "v2", labels: ["d"] });
    clearResponseCache();

    // Non-newest version: labels are replaced, "latest" is not released.
    const p1 = await apiPatch(`${V2}/${name}/versions/1`, { newLabels: ["c"] });
    expect(p1.status).toBe(200);
    expect(p1.body.labels).toEqual(["c"]);
    clearResponseCache();
    const v2 = await apiGet(`${V2}/${name}?version=2`);
    expect(v2.body.labels).toEqual(["d", "latest"]);

    // Claiming "d" for v1 removes it from the newest version.
    const p2 = await apiPatch(`${V2}/${name}/versions/1`, { newLabels: ["d"] });
    expect(p2.status).toBe(200);
    expect(p2.body.labels).toEqual(["d"]);
    clearResponseCache();
    const v2b = await apiGet(`${V2}/${name}?version=2`);
    expect(v2b.body.labels).toEqual(["latest"]);

    // Newest version: "latest" is (re)attached by the system.
    const p3 = await apiPatch(`${V2}/${name}/versions/2`, { newLabels: ["e"] });
    expect(p3.body.labels).toEqual(["e", "latest"]);

    // A caller-provided "latest" is stripped and still managed by the system.
    const p4 = await apiPatch(`${V2}/${name}/versions/2`, { newLabels: ["latest", "f"] });
    expect(p4.body.labels).toEqual(["f", "latest"]);

    // Missing newLabels → 400; unknown version → 404.
    const bad = await apiPatch(`${V2}/${name}/versions/2`, {});
    expect(bad.status).toBe(400);
    const nf = await apiPatch(`${V2}/${name}/versions/99`, { newLabels: ["x"] });
    expect(nf.status).toBe(404);
    expect(nf.body.message).toBe(`Prompt not found: '${name}' with version '99'`);
  });

  it("resolves dependencies with the resolve switch", async () => {
    const child = pname("child");
    const parent = pname("parent");
    // Note: labels are globally unique per project, so only ONE prompt may
    // hold "production" — the parent deliberately carries no labels and is
    // fetched via its own "latest" label.
    const childRes = await apiPost(V2, {
      name: child,
      prompt: "child content",
      labels: ["production"],
    });
    expect(childRes.status).toBe(200);
    const parentRes = await apiPost(V2, {
      name: parent,
      prompt: `Hi {{prompt:${child}@production}}`,
    });
    expect(parentRes.status).toBe(200);
    clearResponseCache();

    // resolve=false → raw stored prompt, dependency tag intact, graph null.
    const raw = await apiGet(`${V2}/${parent}?label=latest&resolve=false`);
    expect(raw.status).toBe(200);
    expect(raw.body.prompt).toBe(`Hi {{prompt:${child}@production}}`);
    expect(raw.body.resolutionGraph).toBeNull();

    // Default (resolve=true) → placeholder replaced, resolutionGraph present.
    const resolved = await apiGet(`${V2}/${parent}?label=latest`);
    expect(resolved.status).toBe(200);
    expect(resolved.body.prompt).toBe("Hi child content");
    expect(resolved.body.resolutionGraph).not.toBeNull();
    expect(resolved.body.resolutionGraph[child]).toBeDefined();
    expect(resolved.body.resolutionGraph[child].version).toBe(1);
    expect(resolved.body.resolutionGraph[child].labels).toEqual(
      expect.arrayContaining(["production"]),
    );
    expect(resolved.body.resolutionGraph[child].dependencies).toEqual({});

    // The dependency reference is persisted for later resolution.
    const deps = await prisma
      .select()
      .from(promptDependencies)
      .where(
        and(
          eq(promptDependencies.projectId, TEST_PROJECT_ID),
          eq(promptDependencies.childName, child),
        ),
      );
    expect(deps.length).toBe(1);
  });

  it("resolves dependencies inside chat messages", async () => {
    const child = pname("chat-child");
    const parent = pname("chat-parent");
    await apiPost(V2, { name: child, prompt: "inner", labels: ["prod-a"] });
    await apiPost(V2, {
      name: parent,
      prompt: [{ role: "user", content: `wrap {{prompt:${child}#1}}` }],
      type: "chat",
    });
    clearResponseCache();

    const raw = await apiGet(`${V2}/${parent}?label=latest&resolve=false`);
    expect(raw.body.prompt[0].content).toBe(`wrap {{prompt:${child}#1}}`);
    expect(raw.body.resolutionGraph).toBeNull();

    const resolved = await apiGet(`${V2}/${parent}?label=latest`);
    expect(resolved.body.prompt[0].content).toBe("wrap inner");
    expect(resolved.body.resolutionGraph[child].version).toBe(1);
  });

  it("deletes all versions with 204 and cleans up dependency rows", async () => {
    const name = pname("del");
    await apiPost(V2, { name, prompt: "v1" });
    await apiPost(V2, { name, prompt: "v2" });

    const del = await apiDelete(`${V2}/${name}`);
    expect(del.status).toBe(204);
    expect(del.body).toBeNull();

    clearResponseCache();
    expect((await apiGet(`${V2}/${name}`)).status).toBe(404);
    expect((await apiGet(`${V2}/${name}?version=1`)).status).toBe(404);

    // Deleting a referenced child clears the childName dependency rows.
    const child = pname("del-child");
    const parent = pname("del-parent");
    await apiPost(V2, { name: child, prompt: "c" });
    await apiPost(V2, { name: parent, prompt: `{{prompt:${child}@latest}}` });
    let deps = await prisma
      .select()
      .from(promptDependencies)
      .where(
        and(
          eq(promptDependencies.projectId, TEST_PROJECT_ID),
          eq(promptDependencies.childName, child),
        ),
      );
    expect(deps.length).toBe(1);

    const delChild = await apiDelete(`${V2}/${child}`);
    expect(delChild.status).toBe(204);
    deps = await prisma
      .select()
      .from(promptDependencies)
      .where(
        and(
          eq(promptDependencies.projectId, TEST_PROJECT_ID),
          eq(promptDependencies.childName, child),
        ),
      );
    expect(deps.length).toBe(0);
  });

  it("deletes filtered versions by label/version", async () => {
    const name = pname("del-label");
    await apiPost(V2, { name, prompt: "v1", labels: ["prod-a"] });
    await apiPost(V2, { name, prompt: "v2", labels: ["prod-b"] });

    const del = await apiDelete(`${V2}/${name}?label=prod-a`);
    expect(del.status).toBe(204);
    clearResponseCache();
    expect((await apiGet(`${V2}/${name}?version=1`)).status).toBe(404);
    expect((await apiGet(`${V2}/${name}?version=2`)).status).toBe(200);

    const delByVersion = await apiDelete(`${V2}/${name}?version=2`);
    expect(delByVersion.status).toBe(204);
    clearResponseCache();
    expect((await apiGet(`${V2}/${name}?version=2`)).status).toBe(404);

    // No match → 404; label+version together → 400.
    const nf = await apiDelete(`${V2}/${pname("nope")}`);
    expect(nf.status).toBe(404);
    const both = await apiDelete(`${V2}/${name}?label=prod-a&version=1`);
    expect(both.status).toBe(400);
  });

  it("lists prompt metadata with filters (PromptMetaListResponse)", async () => {
    const a = pname("list-a");
    const b = pname("list-b");
    await apiPost(V2, {
      name: a,
      prompt: "a1",
      labels: ["production"],
      tags: ["blue"],
      config: { k: 1 },
    });
    await apiPost(V2, {
      name: a,
      prompt: "a2",
      labels: ["staging"],
      tags: ["blue"],
      config: { k: 2 },
    });
    await apiPost(V2, { name: b, prompt: "b1", tags: ["red"] });
    clearResponseCache();

    const all = await apiGet(`${V2}?limit=100`);
    expect(all.status).toBe(200);
    expect(all.body.meta.page).toBe(1);
    expect(all.body.meta.limit).toBe(100);
    expect(all.body.meta.totalItems).toBeGreaterThanOrEqual(3);
    expect(all.body.meta.totalPages).toBe(
      Math.ceil(all.body.meta.totalItems / all.body.meta.limit),
    );

    // PromptMeta: no prompt/config fields; name-level aggregation.
    const aMeta = all.body.data.find((d: any) => d.name === a);
    expect(aMeta).toBeDefined();
    expect(aMeta.versions).toEqual(expect.arrayContaining([1, 2]));
    expect(aMeta.labels).toEqual(expect.arrayContaining(["production", "staging"]));
    expect(aMeta.tags).toEqual(["blue"]);
    expect(aMeta.lastConfig).toEqual({ k: 2 });
    expect(typeof aMeta.lastUpdatedAt).toBe("string");
    expect(aMeta).not.toHaveProperty("prompt");
    expect(aMeta).not.toHaveProperty("config");

    // name filter.
    const byName = await apiGet(`${V2}?name=${a}`);
    expect(byName.body.meta.totalItems).toBe(1);
    expect(byName.body.data[0].name).toBe(a);

    // label filter → aggregation only over matching versions; lastConfig is
    // the most recent matching version's config. ("latest" was claimed by
    // name b later on, since labels are globally unique.)
    const byLabel = await apiGet(`${V2}?label=staging`);
    const aByLabel = byLabel.body.data.find((d: any) => d.name === a);
    expect(aByLabel.versions).toEqual([2]);
    expect(aByLabel.labels).toEqual(expect.arrayContaining(["staging"]));
    expect(aByLabel.lastConfig).toEqual({ k: 2 });

    // tag filter.
    const byTag = await apiGet(`${V2}?tag=red`);
    expect(byTag.body.data.some((d: any) => d.name === b)).toBe(true);

    // updatedAt range filters.
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const from = await apiGet(`${V2}?fromUpdatedAt=${anHourAgo}`);
    expect(from.body.data.some((d: any) => d.name === a)).toBe(true);
    const to = await apiGet(`${V2}?toUpdatedAt=${anHourAgo}`);
    expect(to.body.data.some((d: any) => d.name === a)).toBe(false);

    // Pagination.
    const page = await apiGet(`${V2}?page=1&limit=1`);
    expect(page.body.data.length).toBe(1);
  });

  it("rejects malformed request bodies with 400", async () => {
    const noName = await apiPost(V2, { prompt: "x" });
    expect(noName.status).toBe(400);

    const badChat = await apiPost(V2, { name: pname("bad"), prompt: "not array", type: "chat" });
    expect(badChat.status).toBe(400);

    const badLabel = await apiGet(`${V2}/${pname("bad-q")}?version=abc`);
    expect(badLabel.status).toBe(400);
  });

  it("scopes prompts to the project", async () => {
    const name = pname("iso");
    const created = await apiPost(V2, { name, prompt: "v1", labels: ["production"] }, second.auth);
    expect(created.status).toBe(200);

    clearResponseCache();
    const viaFirst = await apiGet(`${V2}/${name}`);
    expect(viaFirst.status).toBe(404);

    const viaSecond = await apiGet(`${V2}/${name}`, second.auth);
    expect(viaSecond.status).toBe(200);
    expect(viaSecond.body.name).toBe(name);

    const list = await apiGet(`${V2}?limit=100`);
    expect(list.body.data.some((d: any) => d.name === name)).toBe(false);
  });
});
