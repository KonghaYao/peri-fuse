/**
 * Aggregation-order contract for `GET /api/public/sessions`.
 *
 * `GROUP_CONCAT` has no ORDER BY in SQLite and its input order is whatever the
 * scan path delivers. The pre-P1 statement aggregated over a `traces` scan (rowid
 * order) while the current one re-reads its page through
 * `idx_traces_deleted_session` (index order), so `users_concat` / `tags_concat`
 * used to come back in different orders for the same data — a client-visible
 * order that depended on the query plan and on the DB file layout. The route now
 * sorts both parsed arrays with the default comparator (UTF-16 code-unit order,
 * locale independent); value set, CHAR(31) splitting, de-duplication and
 * null/empty handling are unchanged.
 *
 * The seeded corpora below pin, for every filter/sort shape of the statement:
 * identical logical data written in different physical orders yields identical
 * arrays; those arrays match an oracle over the stored rows (content,
 * de-duplication, unicode/comma/space, NULL/empty users, isolation); and the
 * value sets still match the frozen pre-P1 statement, whose raw concat order may
 * differ — the divergence count is logged. Traces are ingested one request at a
 * time: `processEventBatchLite` sorts a batch by timestamp, so a batch cannot
 * choose the physical row order.
 */
import { randomUUID } from "node:crypto";
import type { TelemetryDBAdapter, TelemetryQueryOpts } from "@peri-fuse/shared/src/server/adapters";
import { getTelemetryDB } from "@peri-fuse/shared/src/server/adapters";
import { beforeAll, describe, expect, it } from "vitest";
import { getApp } from "./helpers";
import { createSecondProject } from "./second-project";
import { legacySessionListSql } from "./sessions-bench-baseline";

const US = "\u001f";
const PAGE_LIMIT = 500;
const DAY_MS = 86_400_000;
const CORPUS_EPOCH = Date.UTC(2026, 6, 1);
/** Inside the corpus window, so the time filter keeps part of it. */
const CORPUS_FROM = new Date(CORPUS_EPOCH + DAY_MS).toISOString();

// ---------------------------------------------------------------------------
// Seeded corpus generation
// ---------------------------------------------------------------------------

/** Deterministic PRNG — the corpora are random but identical on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(values: T[], rng: () => number): T[] {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index--) {
    const swap = Math.floor(rng() * (index + 1));
    [out[index], out[swap]] = [out[swap] as T, out[index] as T];
  }
  return out;
}

/** Users exercising commas, spaces, unicode and the empty/NULL edge cases. */
const USER_POOL = [
  null,
  "",
  "user-a",
  "user-b",
  "user,comma",
  " lead-and-trail ",
  "用户-α",
  "Ünïcode-ç",
];

/** Tags overlapping across the traces of a session. */
const TAG_POOL = ["alpha", "beta", "gamma,comma", "标签-一", "Ünïcode-tag", "dup", "A-upper"];

type TracePlan = {
  id: string;
  sessionId: string;
  userId: string | null;
  tags: string[];
  timestamp: string;
  deleted: boolean;
};

type CorpusPlan = { name: string; traces: TracePlan[] };

function pick<T>(rng: () => number, values: T[]): T {
  return values[Math.floor(rng() * values.length)] as T;
}

function buildCorpus(name: string, seed: number): CorpusPlan {
  const rng = mulberry32(seed);
  const traces: TracePlan[] = [];
  const sessionCount = 2 + Math.floor(rng() * 2);
  for (let session = 0; session < sessionCount; session++) {
    const sessionId = `${name}-session-${session}`;
    const traceCount = 2 + Math.floor(rng() * 4);
    const stamps = shuffled(
      Array.from({ length: traceCount }, (_, index) => index),
      rng,
    );
    for (let index = 0; index < traceCount; index++) {
      traces.push({
        id: `${name}-trace-${session}-${index}`,
        sessionId,
        userId: pick(rng, USER_POOL),
        tags: Array.from({ length: Math.floor(rng() * 3) }, () => pick(rng, TAG_POOL)),
        // Distinct timestamps inside a session; written out of order below.
        timestamp: new Date(CORPUS_EPOCH + stamps[index] * DAY_MS).toISOString(),
        deleted: rng() < 0.15,
      });
    }
  }
  return { name, traces };
}

const bySession = (traces: TracePlan[]) => {
  const grouped = new Map<string, TracePlan[]>();
  for (const trace of traces) {
    grouped.set(trace.sessionId, [...(grouped.get(trace.sessionId) ?? []), trace]);
  }
  return grouped;
};

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Index order (session, then timestamp): the natural write order. */
const indexOrder = (traces: TracePlan[]): TracePlan[] =>
  [...traces].sort(
    (left, right) =>
      compare(left.sessionId, right.sessionId) || compare(left.timestamp, right.timestamp),
  );

/**
 * Same logical traces, physical write order deliberately outside the index
 * order: sessions and rows are shuffled, then every multi-row session is rotated
 * until its timestamp sequence differs from the index order.
 */
function shuffledOrder(traces: TracePlan[], seed: number): TracePlan[] {
  const rng = mulberry32(seed);
  const out: TracePlan[] = [];
  for (const group of shuffled([...bySession(traces).values()], rng)) {
    const rows = shuffled(group, rng);
    const sorted = rows.map((trace) => trace.timestamp).sort();
    for (let attempt = 0; attempt < rows.length; attempt++) {
      if (rows.map((trace) => trace.timestamp).join() !== sorted.join()) break;
      rows.push(rows.shift() as TracePlan);
    }
    out.push(...rows);
  }
  return out;
}

/** Filter/sort combinations exercising the different access paths. */
function queryMatrix(corpus: CorpusPlan): [string, string][] {
  const sessions = [...bySession(corpus.traces).keys()].sort();
  return [
    ["unfiltered", ""],
    ["session", `&sessionId=${encodeURIComponent(sessions[0] as string)}`],
    ["tag", `&tags=${encodeURIComponent("alpha")}`],
    ["user", "&userId=user"],
    ["environment", "&environment=default"],
    ["window", `&fromTimestamp=${encodeURIComponent(CORPUS_FROM)}`],
    ["ordered cost", "&orderBy=totalCost.desc"],
    ["ordered traces", "&orderBy=countTraces.asc"],
    ["ordered duration", "&orderBy=sessionDuration.desc"],
  ];
}

// ---------------------------------------------------------------------------
// Seeding + read-back
// ---------------------------------------------------------------------------

type StoredRow = {
  id: string;
  session_id: string;
  user_id: string | null;
  tags: string | null;
  timestamp: string;
  is_deleted: number;
};

type Seeded = { projectId: string; auth: string };

async function ingestOne(auth: string, trace: TracePlan): Promise<void> {
  const res = await getApp().request("/api/public/ingestion", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      batch: [
        {
          id: randomUUID(),
          type: "trace-create",
          timestamp: trace.timestamp,
          body: {
            id: trace.id,
            sessionId: trace.sessionId,
            userId: trace.userId,
            tags: trace.tags,
            timestamp: trace.timestamp,
          },
        },
      ],
    }),
  });
  const body = (await res.json()) as { errors?: unknown[] };
  expect(res.status, `${trace.id}: ${JSON.stringify(body).slice(0, 300)}`).toBe(207);
  expect(body.errors ?? [], trace.id).toEqual([]);
}

/** Writes one corpus version; one request per trace pins the physical row order. */
async function seedCorpus(traces: TracePlan[]): Promise<Seeded> {
  const project = await createSecondProject();
  for (const trace of traces) await ingestOne(project.auth, trace);
  // Re-write a few rows (same data, new rowid at the end of the file) so the
  // physical layout contradicts the index order even for the "natural" version.
  for (const trace of traces.filter((entry) => !entry.deleted).slice(0, 2)) {
    await getTelemetryDB().command({
      query: "DELETE FROM traces WHERE project_id = @projectId AND id = @id",
      params: { projectId: project.projectId, id: trace.id },
    });
    await ingestOne(project.auth, trace);
  }
  for (const trace of traces.filter((entry) => entry.deleted)) {
    const result = await getTelemetryDB().command({
      query: "UPDATE traces SET is_deleted = 1 WHERE project_id = @projectId AND id = @id",
      params: { projectId: project.projectId, id: trace.id },
    });
    expect(result.changes, `${trace.id} soft delete`).toBe(1);
  }
  return { projectId: project.projectId, auth: project.auth };
}

/** Raw rows in physical (rowid) order — the order a `traces` scan delivers. */
async function storedRows(projectId: string): Promise<StoredRow[]> {
  return getTelemetryDB().query<StoredRow>({
    query: `SELECT id, session_id, user_id, tags, timestamp, is_deleted FROM traces
            WHERE project_id = @projectId ORDER BY rowid`,
    params: { projectId },
  });
}

// ---------------------------------------------------------------------------
// Oracles and API access
// ---------------------------------------------------------------------------

type SessionAggregate = { userIds: string[]; traceTags: string[] };

/** Oracle: aggregates over the stored rows, sorted with the default comparator. */
function oracle(rows: StoredRow[]): Map<string, SessionAggregate> {
  const users = new Map<string, Set<string>>();
  const tags = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.is_deleted !== 0) continue;
    const sessionUsers = users.get(row.session_id) ?? new Set<string>();
    const sessionTags = tags.get(row.session_id) ?? new Set<string>();
    users.set(row.session_id, sessionUsers);
    tags.set(row.session_id, sessionTags);
    if (row.user_id !== null && row.user_id !== "") sessionUsers.add(row.user_id);
    if (row.tags) {
      for (const tag of JSON.parse(row.tags) as unknown[]) {
        if (typeof tag === "string") sessionTags.add(tag);
      }
    }
  }
  return new Map(
    [...users.keys()].map((sessionId) => [
      sessionId,
      {
        userIds: [...(users.get(sessionId) ?? [])].sort(),
        traceTags: [...(tags.get(sessionId) ?? [])].sort(),
      },
    ]),
  );
}

/** Mirrors the route's parse layer but keeps the raw concat order. */
function parseConcatUsers(concat: unknown): string[] {
  if (concat === null || concat === undefined) return [];
  return String(concat).split(US).filter(Boolean);
}

function parseConcatTags(concat: unknown): string[] {
  if (concat === null || concat === undefined) return [];
  const seen = new Set<string>();
  for (const raw of String(concat).split(US)) {
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      for (const tag of parsed) if (typeof tag === "string") seen.add(tag);
    } catch {
      // ignore malformed tag blobs, same as the route
    }
  }
  return [...seen];
}

/** The client-visible arrays, straight from the public API. */
async function fetchAggregates(
  label: string,
  auth: string,
  search = "",
): Promise<Map<string, SessionAggregate>> {
  const res = await getApp().request(
    `/api/public/sessions?limit=${PAGE_LIMIT}${search}&__case=${label}`,
    { headers: { Authorization: auth } },
  );
  expect(res.status, `${label}${search}`).toBe(200);
  const body = (await res.json()) as {
    data: { id: string; userIds: string[]; traceTags: string[] }[];
  };
  return new Map(
    body.data.map((row) => [row.id, { userIds: row.userIds, traceTags: row.traceTags }]),
  );
}

/** Runs one request and returns the page statement the route executed. */
async function captureRouteStatement(
  label: string,
  auth: string,
): Promise<{ query: string; params: Record<string, unknown> }> {
  const db = getTelemetryDB();
  const captured: { query: string; params: Record<string, unknown> }[] = [];
  const original = db.query;
  db.query = (async (opts: TelemetryQueryOpts) => {
    captured.push({ query: opts.query, params: opts.params ?? {} });
    return original.call(db, opts);
  }) as TelemetryDBAdapter["query"];
  try {
    const res = await getApp().request(`/api/public/sessions?limit=${PAGE_LIMIT}&__case=${label}`, {
      headers: { Authorization: auth },
    });
    expect(res.status, label).toBe(200);
  } finally {
    db.query = original;
  }
  const statement = captured.find((entry) => !/COUNT\(DISTINCT session_id\)/.test(entry.query));
  expect(statement, `${label}: page statement`).toBeDefined();
  return statement as { query: string; params: Record<string, unknown> };
}

// ---------------------------------------------------------------------------

type ConcatRow = { id: string; users_concat: unknown; tags_concat: unknown };

const CORPORA = [
  buildCorpus("order-a", 0x5eed01),
  buildCorpus("order-b", 0x5eed02),
  buildCorpus("order-c", 0x5eed03),
];

describe("GET /api/public/sessions aggregation order", () => {
  const seeded = new Map<string, { natural: Seeded; shuffled: Seeded }>();

  beforeAll(async () => {
    const noise = await createSecondProject();
    for (const corpus of CORPORA) {
      const natural = await seedCorpus(indexOrder(corpus.traces));
      const seed = 0xbad5eed ^ corpus.traces.length;
      const other = await seedCorpus(shuffledOrder(corpus.traces, seed));
      seeded.set(corpus.name, { natural, shuffled: other });
      // Cross-project noise: same session ids, unique user + tag.
      for (const sessionId of bySession(corpus.traces).keys()) {
        await ingestOne(noise.auth, {
          id: `${corpus.name}-${sessionId}-noise`,
          sessionId,
          userId: `noise-user-${corpus.name}`,
          tags: [`noise-tag-${corpus.name}`],
          timestamp: new Date(CORPUS_EPOCH).toISOString(),
          deleted: false,
        });
      }
    }
  }, 600_000);

  it("writes the same logical data in two genuinely different physical orders", async () => {
    for (const corpus of CORPORA) {
      const entry = seeded.get(corpus.name) as { natural: Seeded; shuffled: Seeded };
      const naturalRows = await storedRows(entry.natural.projectId);
      const shuffledRows = await storedRows(entry.shuffled.projectId);
      expect(
        naturalRows.map((row) => row.id),
        `${corpus.name}: physical order`,
      ).not.toEqual(shuffledRows.map((row) => row.id));
      expect(
        shuffledRows.map((row) => row.id).sort(),
        `${corpus.name}: same logical traces`,
      ).toEqual(naturalRows.map((row) => row.id).sort());
      // Sessions whose shuffled row order is outside the (timestamp) index
      // order — the condition that makes GROUP_CONCAT's input order observable.
      const offIndex = [...bySession(corpus.traces).keys()].filter((sessionId) => {
        const rows = shuffledRows.filter((row) => row.session_id === sessionId);
        return (
          rows.length > 1 &&
          rows.map((row) => row.timestamp).join() !==
            rows
              .map((row) => row.timestamp)
              .sort()
              .join()
        );
      });
      expect(offIndex.length, `${corpus.name}: sessions outside index order`).toBeGreaterThan(0);
      // The write path must have stored exactly the planned corpus.
      const stored = new Map(naturalRows.map((row) => [row.id, row]));
      expect(stored.size, corpus.name).toBe(corpus.traces.length);
      for (const trace of corpus.traces) {
        const row = stored.get(trace.id) as StoredRow;
        expect(row.session_id, trace.id).toBe(trace.sessionId);
        expect(row.user_id, `${trace.id} user`).toBe(trace.userId);
        expect(row.is_deleted, `${trace.id} deleted`).toBe(trace.deleted ? 1 : 0);
        expect((JSON.parse(row.tags as string) as string[]).sort(), `${trace.id} tags`).toEqual(
          [...trace.tags].sort(),
        );
      }
    }
  }, 120_000);

  it("returns the same arrays for the same data written in two physical orders", async () => {
    for (const corpus of CORPORA) {
      const entry = seeded.get(corpus.name) as { natural: Seeded; shuffled: Seeded };
      for (const [name, search] of queryMatrix(corpus)) {
        const natural = await fetchAggregates(`${corpus.name}-${name}`, entry.natural.auth, search);
        const other = await fetchAggregates(`${corpus.name}-${name}`, entry.shuffled.auth, search);
        expect([...natural.keys()].sort(), `${corpus.name} ${name}`).toEqual(
          [...other.keys()].sort(),
        );
        for (const [sessionId, aggregate] of natural) {
          expect(other.get(sessionId), `${corpus.name} ${name} ${sessionId}`).toEqual(aggregate);
        }
      }
    }
  }, 120_000);

  it("matches the oracle derived from the stored rows", async () => {
    for (const corpus of CORPORA) {
      const entry = seeded.get(corpus.name) as { natural: Seeded };
      const expected = oracle(await storedRows(entry.natural.projectId));
      const actual = await fetchAggregates(`${corpus.name}-oracle`, entry.natural.auth);
      expect([...actual.keys()].sort(), corpus.name).toEqual([...expected.keys()].sort());
      for (const [sessionId, aggregate] of expected) {
        expect(actual.get(sessionId), `${corpus.name} ${sessionId}`).toEqual(aggregate);
      }
      for (const aggregate of actual.values()) {
        const values = aggregate.userIds.concat(aggregate.traceTags);
        expect(
          values.filter((value) => value.startsWith("noise-")),
          corpus.name,
        ).toEqual([]);
      }
    }
  }, 120_000);

  it("keeps the value sets of the frozen pre-P1 statement", async () => {
    for (const corpus of CORPORA) {
      const entry = seeded.get(corpus.name) as { natural: Seeded; shuffled: Seeded };
      let orderSensitive = 0;
      for (const variant of [entry.natural, entry.shuffled]) {
        const actual = await fetchAggregates(`${corpus.name}-baseline`, variant.auth);
        const captured = await captureRouteStatement(`${corpus.name}-captured`, variant.auth);
        const currentRows = await getTelemetryDB().query<ConcatRow>({
          query: captured.query,
          params: captured.params,
        });
        const baselineRows = await getTelemetryDB().query<ConcatRow>({
          query: legacySessionListSql(new URLSearchParams(`?limit=${PAGE_LIMIT}`)),
          params: { ...captured.params, limit: PAGE_LIMIT, offset: 0 },
        });
        expect(baselineRows.map((row) => row.id).sort(), `${corpus.name}: rows`).toEqual(
          currentRows.map((row) => row.id).sort(),
        );
        for (const baselineRow of baselineRows) {
          const currentRow = currentRows.find((row) => row.id === baselineRow.id) as ConcatRow;
          // Raw concat order is not a contract — only the sorted value sets are.
          expect(
            {
              userIds: parseConcatUsers(baselineRow.users_concat).sort(),
              traceTags: parseConcatTags(baselineRow.tags_concat).sort(),
            },
            `${corpus.name} ${baselineRow.id}`,
          ).toEqual(actual.get(baselineRow.id));
          if (
            String(currentRow.users_concat) !== String(baselineRow.users_concat) ||
            String(currentRow.tags_concat) !== String(baselineRow.tags_concat)
          ) {
            orderSensitive += 1;
          }
        }
      }
      console.log(
        `[sessions-concat-order] ${corpus.name}: ${corpus.traces.length} traces, ` +
          `${orderSensitive} raw GROUP_CONCAT order divergences (baseline vs current)`,
      );
    }
  }, 120_000);
});
