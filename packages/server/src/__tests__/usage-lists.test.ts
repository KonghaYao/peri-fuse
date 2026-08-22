import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiGet, apiPost } from "./helpers";
import { createSecondProject } from "./second-project";

function traceWithGeneration(params: {
  traceId: string;
  observationId: string;
  userId: string;
  sessionId: string;
  environment: string;
  timestamp: string;
  tokens: number;
}) {
  return [
    {
      id: randomUUID(),
      type: "trace-create",
      timestamp: params.timestamp,
      body: {
        id: params.traceId,
        timestamp: params.timestamp,
        userId: params.userId,
        sessionId: params.sessionId,
        environment: params.environment,
      },
    },
    {
      id: randomUUID(),
      type: "generation-create",
      timestamp: params.timestamp,
      body: {
        id: params.observationId,
        traceId: params.traceId,
        startTime: params.timestamp,
        environment: params.environment,
        usage: { input: params.tokens, output: 0, total: params.tokens },
      },
    },
  ];
}

describe("usage list scopes", () => {
  it("uses the same environment and time window for user and session metrics", async () => {
    const suffix = randomUUID();
    const userId = `usage-user-${suffix}`;
    const sessionId = `usage-session-${suffix}`;
    const oldTimestamp = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const recentTimestamp = new Date(Date.now() - 3_600_000).toISOString();
    const subjectProject = await createSecondProject();

    const ingestion = await apiPost(
      "/api/public/ingestion",
      {
        batch: [
          ...traceWithGeneration({
            traceId: `production-${suffix}`,
            observationId: `production-observation-${suffix}`,
            userId,
            sessionId,
            environment: "production",
            timestamp: recentTimestamp,
            tokens: 30,
          }),
          ...traceWithGeneration({
            traceId: `production-old-${suffix}`,
            observationId: `production-old-observation-${suffix}`,
            userId,
            sessionId,
            environment: "production",
            timestamp: oldTimestamp,
            tokens: 60,
          }),
          ...traceWithGeneration({
            traceId: `staging-recent-${suffix}`,
            observationId: `staging-recent-observation-${suffix}`,
            userId,
            sessionId,
            environment: "staging",
            timestamp: recentTimestamp,
            tokens: 300,
          }),
        ],
      },
      {},
      subjectProject.auth,
    );
    expect(ingestion.status).toBe(207);

    const secondProject = await createSecondProject();
    const hidden = await apiPost(
      "/api/public/ingestion",
      {
        batch: traceWithGeneration({
          traceId: `hidden-${suffix}`,
          observationId: `hidden-observation-${suffix}`,
          userId,
          sessionId,
          environment: "production",
          timestamp: recentTimestamp,
          tokens: 900,
        }),
      },
      {},
      secondProject.auth,
    );
    expect(hidden.status).toBe(207);

    const fromTimestamp = encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString());
    const query = `environment=production&fromTimestamp=${fromTimestamp}`;
    const users = await apiGet<any>(
      `/api/public/users?userId=${encodeURIComponent(userId)}&${query}`,
      subjectProject.auth,
    );
    const sessions = await apiGet<any>(
      `/api/public/sessions?userId=${encodeURIComponent(userId)}&${query}`,
      subjectProject.auth,
    );

    expect(users.status).toBe(200);
    expect(users.body.data).toHaveLength(1);
    expect(users.body.data[0]).toMatchObject({
      id: userId,
      countTraces: 1,
      countObservations: 1,
      totalTokens: 30,
      environment: "production",
    });
    expect(sessions.status).toBe(200);
    expect(sessions.body.data).toHaveLength(1);
    expect(sessions.body.data[0]).toMatchObject({
      id: sessionId,
      countTraces: 1,
      totalTokens: 30,
      environment: "production",
    });

    const toTimestamp = encodeURIComponent(new Date(Date.now() - 2 * 86_400_000).toISOString());
    const oldQuery = `environment=production&toTimestamp=${toTimestamp}`;
    const oldUsers = await apiGet<any>(
      `/api/public/users?userId=${encodeURIComponent(userId)}&${oldQuery}`,
      subjectProject.auth,
    );
    const oldSessions = await apiGet<any>(
      `/api/public/sessions?userId=${encodeURIComponent(userId)}&${oldQuery}`,
      subjectProject.auth,
    );
    expect(oldUsers.body.data[0]).toMatchObject({ countTraces: 1, totalTokens: 60 });
    expect(oldSessions.body.data[0]).toMatchObject({ countTraces: 1, totalTokens: 60 });
  });

  it("rejects invalid time windows", async () => {
    expect(await apiGet("/api/public/users?fromTimestamp=invalid")).toMatchObject({ status: 400 });
    expect(await apiGet("/api/public/sessions?toTimestamp=invalid")).toMatchObject({ status: 400 });
  });
});
