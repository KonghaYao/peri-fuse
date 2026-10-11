import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rejectSql } from "../../db/testing";
import { selectVersionedColumns } from "./ingestion-versions";
import { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";

const time = "2026-01-02 00:00:00.000";
const older = "2026-01-01 00:00:00.000";
const newer = "2026-01-03 00:00:00.000";
let adapter: SQLiteTelemetryAdapter;
let filename: string;
const sql = () => adapter.getDatabase();
const read = (project = "p") =>
  sql().get("SELECT * FROM traces WHERE project_id=? AND id='t'", project);
const insert = (
  fields: Record<string, unknown>,
  eventId = "b",
  eventTime = time,
  updatedAt = time,
  project = "p",
) =>
  adapter.insert({
    table: "traces",
    records: [
      { project_id: project, id: "t", event_ts: eventTime, updated_at: updatedAt, ...fields },
    ],
    updateColumns: [Object.keys(fields)],
    eventIds: [eventId],
  });

beforeEach(async () => {
  filename = join(mkdtempSync(join(tmpdir(), "peri-ingestion-test-mutations-")), "telemetry.db");
  adapter = new SQLiteTelemetryAdapter(filename);
  await adapter.initialize();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await adapter.close();
});

it("keeps retry values and every projection unchanged, including after reopening", async () => {
  await insert({ name: "first", input: "first", timestamp: time });
  const before = await read();
  const projections = await sql().all("SELECT * FROM ingestion_field_versions");
  const daily = await sql().all("SELECT * FROM daily_stats_dirty");
  const search = await sql().all("SELECT * FROM search_dirty");
  await adapter.close();
  adapter = new SQLiteTelemetryAdapter(filename);
  await adapter.initialize();
  const changes = await sql().get("SELECT total_changes() AS n");
  await insert(
    { name: "retry must not win", input: "changed retry", timestamp: time },
    "b",
    time,
    newer,
  );
  expect(await sql().get("SELECT total_changes() AS n")).toEqual(changes);
  expect(await read()).toEqual(before);
  expect(await sql().all("SELECT * FROM ingestion_field_versions")).toEqual(projections);
  expect(await sql().all("SELECT * FROM daily_stats_dirty")).toEqual(daily);
  expect(await sql().all("SELECT * FROM search_dirty")).toEqual(search);
});

it.each([
  { id: "a", ts: time, fields: { name: "lost" }, name: "first", updated: time, event: time },
  { id: "c", ts: time, fields: { name: "won" }, name: "won", updated: newer, event: time },
  { id: "b", ts: time, fields: { name: "retry" }, name: "first", updated: time, event: time },
  {
    id: "z",
    ts: older,
    fields: { name: "lost", output: "late" },
    name: "first",
    updated: time,
    event: time,
  },
  { id: "a", ts: newer, fields: { name: "won" }, name: "won", updated: newer, event: newer },
])("preserves field conflicts and timestamp policy: $id / $ts / $name", async (test) => {
  await insert({ name: "first", timestamp: time });
  await insert(test.fields, test.id, test.ts, newer);
  expect(await read()).toMatchObject({
    name: test.name,
    event_ts: test.event,
    updated_at: test.updated,
  });
  if ("output" in test.fields) expect((await read()).output).toBe("late");
});

it("does not discard new fields from the same envelope or reuse IDs across entities/projects", async () => {
  await insert({ name: "first" });
  await insert({ name: "retry", output: "new field" });
  await insert({ name: "other project" }, "b", time, time, "q");
  await adapter.insert({
    table: "traces",
    records: [
      { project_id: "p", id: "other", name: "other entity", event_ts: time, updated_at: time },
    ],
    updateColumns: [["name"]],
    eventIds: ["b"],
  });
  expect(await read()).toMatchObject({ name: "first", output: "new field" });
  expect(await read("q")).toMatchObject({ name: "other project" });
  expect(await sql().get("SELECT name FROM traces WHERE project_id='p' AND id='other'")).toEqual({
    name: "other entity",
  });
});

it("protects historical non-null fields, fills NULL and persists version-only initialization once", async () => {
  await sql().run(
    "INSERT INTO traces(project_id,id,event_ts,updated_at,name,input) VALUES('p','t',?,?,?,?)",
    time,
    time,
    "historical",
    "protected",
  );
  await insert({ name: "old", output: "filled" }, "a", older, newer);
  expect(await read()).toMatchObject({
    name: "historical",
    input: "protected",
    output: "filled",
    event_ts: time,
    updated_at: time,
  });
  const { versions } = await sql().get("SELECT versions FROM ingestion_field_versions");
  expect(JSON.parse(versions)).toMatchObject({
    name: [time, ""],
    input: [time, ""],
    output: [older, "a"],
  });
  await sql().run("DELETE FROM ingestion_field_versions");
  const before = await read();
  await insert({ name: "rejected" }, "a", older, newer);
  expect(await read()).toEqual(before);
  const changes = await sql().get("SELECT total_changes() AS n");
  await insert({ name: "rejected" }, "a", older, newer);
  expect(await sql().get("SELECT total_changes() AS n")).toEqual(changes);
});

it.each([null, "", "existing"])("preserves inherited input rules for %s", async (value) => {
  await adapter.insert({
    table: "traces",
    records: [{ project_id: "p", id: "t", input: value, event_ts: time, updated_at: time }],
    updateColumns: [[]],
    eventIds: ["a"],
  });
  const inherit = () =>
    adapter.insert({
      table: "traces",
      records: [
        { project_id: "p", id: "t", input: "inherited", event_ts: time, updated_at: newer },
      ],
      updateColumns: [[]],
      inheritColumns: [["input"]],
      eventIds: ["b"],
    });
  await inherit();
  expect((await read()).input).toBe(value === null ? "inherited" : value);
  const changes = await sql().get("SELECT total_changes() AS n");
  await inherit();
  expect(await sql().get("SELECT total_changes() AS n")).toEqual(changes);
});

it("does not inherit over explicit NULL and preserves historical input probe semantics", async () => {
  await insert({ input: null });
  const decide = () =>
    sql()
      .transactionAsync((tx) =>
        selectVersionedColumns(
          tx,
          "traces",
          { project_id: "p", id: "t", input: "inherit", event_ts: time },
          [],
          "c",
          ["input"],
        ),
      )
      .immediate();
  expect(await decide()).toMatchObject({
    acceptedColumns: [],
    versionChanged: false,
    entityChanged: false,
  });
  await sql().run("DELETE FROM ingestion_field_versions");
  await sql().run("UPDATE traces SET input='0'");
  expect(await decide()).toMatchObject({
    acceptedColumns: [],
    versionChanged: true,
    entityChanged: false,
  });
});

it("updates event_ts alone without rewriting an unchanged version map", async () => {
  await insert({ name: "first" });
  const versions = await sql().all("SELECT * FROM ingestion_field_versions");
  const decision = await sql()
    .transactionAsync((tx) =>
      selectVersionedColumns(tx, "traces", { project_id: "p", id: "t", event_ts: newer }, [], "a"),
    )
    .immediate();
  expect(decision).toMatchObject({
    acceptedColumns: ["event_ts", "updated_at"],
    versionChanged: false,
    entityChanged: true,
  });
  expect(await sql().all("SELECT * FROM ingestion_field_versions")).toEqual(versions);
});

it("coalesces per-day and per-entity projections and keeps the final event time", async () => {
  const records = [
    { project_id: "p", id: "t", timestamp: time, input: "first", event_ts: time, updated_at: time },
    {
      project_id: "p",
      id: "t",
      timestamp: newer,
      input: "last",
      event_ts: newer,
      updated_at: newer,
    },
    {
      project_id: "p",
      id: "other",
      timestamp: time,
      input: "other",
      event_ts: time,
      updated_at: time,
    },
    {
      project_id: "q",
      id: "t",
      timestamp: time,
      input: "isolated",
      event_ts: time,
      updated_at: time,
    },
  ];
  await adapter.insert({
    table: "traces",
    records,
    updateColumns: records.map(() => ["timestamp", "input"]),
    eventIds: ["a", "b", "a", "a"],
  });
  expect(
    await sql().all(
      "SELECT project_id,day,revision FROM daily_stats_dirty ORDER BY project_id,day",
    ),
  ).toEqual([
    { project_id: "p", day: time.slice(0, 10), revision: 1 },
    { project_id: "p", day: newer.slice(0, 10), revision: 1 },
    { project_id: "q", day: time.slice(0, 10), revision: 1 },
  ]);
  expect(
    await sql().get(
      "SELECT revision,event_time FROM search_dirty WHERE project_id='p' AND source_id='t'",
    ),
  ).toEqual({ revision: 1, event_time: newer });
  expect(
    await sql().all("SELECT project_id,pending FROM search_index_state ORDER BY project_id"),
  ).toEqual([
    { project_id: "p", pending: 2 },
    { project_id: "q", pending: 1 },
  ]);
  await insert({ input: "next" }, "z", newer);
  expect(
    await sql().get(
      "SELECT revision FROM search_source_revisions WHERE project_id='p' AND source_id='t'",
    ),
  ).toEqual({ revision: 2 });
  expect(await sql().get("SELECT pending FROM search_index_state WHERE project_id='p'")).toEqual({
    pending: 2,
  });
});

it("preserves soft delete versions, retry no-op and cross-project isolation", async () => {
  await insert({ is_deleted: 0, timestamp: time });
  await insert({ is_deleted: 0, timestamp: time }, "b", time, time, "q");
  await insert({ is_deleted: 1 }, "c", newer, newer);
  const changes = await sql().get("SELECT total_changes() AS n");
  await insert({ is_deleted: 1 }, "c", newer, newer);
  await insert({ is_deleted: 0 }, "a", older, newer);
  expect(await sql().get("SELECT total_changes() AS n")).toEqual(changes);
  expect((await read()).is_deleted).toBe(1);
  expect((await read("q")).is_deleted).toBe(0);
  await insert({ is_deleted: 0 }, "d", newer, newer);
  expect((await read()).is_deleted).toBe(0);
});

it("deduplicates commandBatch and mergeInsert, while deletion clears field versions", async () => {
  await insert({ timestamp: time, input: "first" });
  await adapter.commandBatch([
    { query: "UPDATE traces SET input='second' WHERE project_id='p' AND id='t'" },
    { query: "UPDATE traces SET input='third' WHERE project_id='p' AND id='t'" },
  ]);
  expect(await sql().get("SELECT revision FROM daily_stats_dirty")).toEqual({ revision: 2 });
  expect(await sql().get("SELECT revision FROM search_source_revisions")).toEqual({ revision: 2 });
  await adapter.mergeInsert({
    table: "traces",
    records: [
      { project_id: "p", id: "t", input: "fourth" },
      { project_id: "p", id: "t", input: "fifth" },
    ],
  });
  expect(await sql().get("SELECT revision FROM daily_stats_dirty")).toEqual({ revision: 3 });
  expect(await sql().get("SELECT revision FROM search_source_revisions")).toEqual({ revision: 3 });
  await adapter.command({ query: "DELETE FROM traces WHERE project_id='p' AND id='t'" });
  expect(await sql().all("SELECT * FROM ingestion_field_versions")).toEqual([]);
  expect(await sql().get("SELECT pending FROM search_index_state")).toEqual({ pending: 1 });
});

it.each(["observations", "scores"])("skips retry writes and metric reads for %s", async (table) => {
  const record = {
    project_id: "p",
    id: "o",
    trace_id: "t",
    name: "first",
    event_ts: time,
    updated_at: time,
  };
  const opts = { table, records: [record], updateColumns: [["name", "trace_id"]], eventIds: ["a"] };
  await adapter.insert(opts);
  const changes = await sql().get("SELECT total_changes() AS n");
  const fault = rejectSql(
    sql(),
    /(?:^\s*(?:INSERT|UPDATE|DELETE)\b|FROM trace_metrics|FROM observations WHERE.*trace_id)/i,
    vi,
  );
  await adapter.insert({ ...opts, records: [{ ...record, name: "retry", updated_at: newer }] });
  fault.mockRestore();
  expect(await sql().get("SELECT total_changes() AS n")).toEqual(changes);
  expect(
    await sql().get(`SELECT name,updated_at FROM ${table} WHERE project_id='p' AND id='o'`),
  ).toEqual({ name: "first", updated_at: time });
});

it("rolls back entities, versions and deduplicated projections if the final dirty write fails", async () => {
  const fault = rejectSql(sql(), /INSERT INTO search_dirty/, vi);
  await expect(insert({ name: "failed", timestamp: time })).rejects.toThrow("synthetic");
  fault.mockRestore();
  for (const table of [
    "traces",
    "ingestion_field_versions",
    "daily_stats_dirty",
    "search_source_revisions",
    "search_dirty",
  ])
    expect(await sql().all(`SELECT * FROM ${table}`)).toEqual([]);
  await insert({ name: "accepted", timestamp: time }, "a");
  expect((await read()).name).toBe("accepted");
});
