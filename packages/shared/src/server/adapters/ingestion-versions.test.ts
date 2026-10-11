import { expect, it } from "vitest";
import { type LocalExecutor, openLocalDatabase } from "../../db/local";
import { initializeIngestionVersions, selectVersionedColumns } from "./ingestion-versions";
import { mutationSnapshotColumns } from "./telemetry-mutations";

type Row = Record<string, unknown>;
type Event = { row: Row; columns: string[]; id: string; inherited?: string[] };

async function originalSelection(db: LocalExecutor, event: Event): Promise<string[]> {
  const { row, columns, id, inherited = [] } = event;
  const key = [row.project_id, "traces", row.id];
  const stored = await db.get(
    "SELECT versions FROM ingestion_field_versions WHERE project_id=? AND entity_type=? AND entity_id=?",
    ...key,
  );
  const versions: Record<string, [string, string]> = stored ? JSON.parse(stored.versions) : {};
  const previous = await db.get(
    stored
      ? "SELECT event_ts,input IS NOT NULL AS input,output IS NOT NULL AS output FROM traces WHERE project_id=? AND id=?"
      : "SELECT * FROM traces WHERE project_id=? AND id=?",
    row.project_id,
    row.id,
  );
  if (!stored && previous) {
    for (const [column, value] of Object.entries(previous)) {
      if (value != null) versions[column] = [String(previous.event_ts ?? ""), ""];
    }
  }
  const incoming: [string, string] = [String(row.event_ts), id];
  const inheritedColumns = inherited.filter(
    (column) =>
      (column === "input" || column === "output") &&
      !columns.includes(column) &&
      !versions[column] &&
      (previous?.[column] == null || (stored !== undefined && previous[column] === 0)),
  );
  const accepted = [...columns, ...inheritedColumns].filter((column) => {
    if (column === "updated_at" || column === "event_ts") return false;
    const old = versions[column];
    if (old && (old[0] > incoming[0] || (old[0] === incoming[0] && old[1] >= incoming[1])))
      return false;
    versions[column] = incoming;
    return true;
  });
  if (!previous || String(previous.event_ts) <= incoming[0])
    accepted.push("event_ts", "updated_at");
  await db.run(
    `INSERT INTO ingestion_field_versions VALUES (?,?,?,?)
    ON CONFLICT(project_id,entity_type,entity_id) DO UPDATE SET versions=excluded.versions`,
    ...key,
    JSON.stringify(versions),
  );
  return accepted;
}

const time = "2026-01-02 00:00:00.000";
const newer = "2026-01-03 00:00:00.000";
const older = "2026-01-01 00:00:00.000";
function event(id: string, eventTime: string, fields: Row, inherited: string[] = []): Event {
  return {
    id,
    row: {
      project_id: "p",
      id: "t",
      event_ts: eventTime,
      updated_at: `updated-${id}-${eventTime}`,
      ...fields,
    },
    columns: Object.keys(fields).filter((column) => !inherited.includes(column)),
    inherited,
  };
}

it.each([false, true])(
  "differentially matches original field decisions (historical=%s)",
  async (historical) => {
    const original = await openLocalDatabase(":memory:");
    const optimized = await openLocalDatabase(":memory:");
    try {
      for (const db of [original, optimized]) {
        await db.exec(`CREATE TABLE traces (
        project_id TEXT,id TEXT,event_ts TEXT,updated_at TEXT,name TEXT,input TEXT,output TEXT,
        timestamp TEXT,user_id TEXT,session_id TEXT,is_deleted INTEGER DEFAULT 0,
        PRIMARY KEY(project_id,id))`);
        await initializeIngestionVersions(db);
        if (historical)
          await db.run(
            "INSERT INTO traces(project_id,id,event_ts,name,input) VALUES('p','t',?,'legacy','')",
            time,
          );
      }
      const events = [
        event("b", time, { name: "first", timestamp: time }),
        event("b", time, { name: "retry", timestamp: time }),
        event("a", time, { name: "smaller ID" }),
        event("c", time, { name: "larger ID" }),
        event("z", older, { name: "older", output: "late field" }),
        event("a", newer, { name: "newer" }),
        event("b", newer, { input: "inherited" }, ["input"]),
        event("b", newer, { input: "retry inheritance" }, ["input"]),
        event("c", newer, { output: null }),
        event("d", newer, { output: "cannot inherit explicit null" }, ["output"]),
        event("e", newer, { is_deleted: 1 }),
        event("e", newer, { is_deleted: 0 }),
        event("f", older, { is_deleted: 0 }),
        event("f", newer, { is_deleted: 0 }),
        {
          ...event("f", newer, { name: "other project" }),
          row: { ...event("f", newer, { name: "other project" }).row, project_id: "q" },
        },
      ];
      for (const current of events) {
        const before = await optimized.get(
          "SELECT * FROM traces WHERE project_id=? AND id=?",
          current.row.project_id,
          current.row.id,
        );
        const oldColumns = await original
          .transactionAsync((tx) => originalSelection(tx, current))
          .immediate();
        const decision = await optimized
          .transactionAsync((tx) =>
            selectVersionedColumns(
              tx,
              "traces",
              current.row,
              current.columns,
              current.id,
              current.inherited,
              mutationSnapshotColumns("traces"),
            ),
          )
          .immediate();
        expect(
          decision.acceptedColumns.filter(
            (column) => column !== "event_ts" && column !== "updated_at",
          ),
        ).toEqual(oldColumns.filter((column) => column !== "event_ts" && column !== "updated_at"));
        for (const [db, columns] of [
          [original, oldColumns],
          [optimized, decision.acceptedColumns],
        ] as const) {
          const keys = Object.keys(current.row);
          await db.run(
            `INSERT INTO traces(${keys.join(",")}) VALUES(${keys.map((key) => `@${key}`).join(",")})
          ON CONFLICT(project_id,id) DO ${columns.length ? `UPDATE SET ${columns.map((key) => `${key}=excluded.${key}`).join(",")}` : "NOTHING"}`,
            current.row,
          );
        }
        const oldRow = await original.get(
          "SELECT * FROM traces WHERE project_id=? AND id=?",
          current.row.project_id,
          current.row.id,
        );
        const newRow = await optimized.get(
          "SELECT * FROM traces WHERE project_id=? AND id=?",
          current.row.project_id,
          current.row.id,
        );
        expect({ ...newRow, updated_at: null }).toEqual({ ...oldRow, updated_at: null });
        expect(newRow.updated_at).toBe(
          decision.acceptedColumns.includes("updated_at") ? oldRow.updated_at : before?.updated_at,
        );
        expect(
          await optimized.all(
            "SELECT * FROM ingestion_field_versions ORDER BY project_id,entity_id",
          ),
        ).toEqual(
          await original.all(
            "SELECT * FROM ingestion_field_versions ORDER BY project_id,entity_id",
          ),
        );
        if (before) {
          for (const column of mutationSnapshotColumns("traces").split(","))
            expect(decision.before?.[column]).toEqual(before[column]);
        }
      }
    } finally {
      await original.close();
      await optimized.close();
    }
  },
);
