/**
 * Project activation keeps previously issued web-ui keys valid.
 *
 * Re-activating a project used to delete the old web-ui key, which killed
 * every already-open browser session for that project (the 401-after-idle
 * bug). Now old keys keep working and only the oldest ones beyond the cap
 * are pruned.
 */
import { describe, expect, it } from "vitest";
import { apiGet, apiPost } from "./helpers";
import { TEST_PROJECT_ID } from "./test-db-paths";

interface Activated {
  projectId: string;
  projectName: string;
  publicKey: string;
  secretKey: string;
}

async function activate(): Promise<Activated> {
  const res = await apiPost<Activated>(
    `/api/manage/projects/${encodeURIComponent(TEST_PROJECT_ID)}/activate`,
    {},
  );
  expect(res.status).toBe(200);
  expect(res.body.publicKey).toBeTruthy();
  expect(res.body.secretKey).toBeTruthy();
  return res.body;
}

function authedProbe(pk: string, sk: string) {
  return apiGet(
    "/api/public/traces?limit=1",
    `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}`,
  );
}

describe("project activation", () => {
  it("keeps previously issued web-ui keys valid after re-activation", async () => {
    const first = await activate();
    expect(await authedProbe(first.publicKey, first.secretKey)).toMatchObject({ status: 200 });

    const second = await activate();
    expect(second.publicKey).not.toBe(first.publicKey);

    // Both sessions keep working — the old key must NOT be deleted.
    expect(await authedProbe(first.publicKey, first.secretKey)).toMatchObject({ status: 200 });
    expect(await authedProbe(second.publicKey, second.secretKey)).toMatchObject({ status: 200 });
  });

  it("prunes only the oldest web-ui keys beyond the cap", async () => {
    const issued: Activated[] = [];
    // Cap is 5; issue 7 keys total so the first two must be pruned.
    for (let i = 0; i < 7; i++) issued.push(await activate());

    const oldest = issued[0];
    const newest = issued[issued.length - 1];
    expect(await authedProbe(oldest.publicKey, oldest.secretKey)).toMatchObject({ status: 401 });
    expect(await authedProbe(newest.publicKey, newest.secretKey)).toMatchObject({ status: 200 });

    // A key inside the cap window still works.
    const middle = issued[issued.length - 3];
    expect(await authedProbe(middle.publicKey, middle.secretKey)).toMatchObject({ status: 200 });
  });
});
