import type { LocalExecutor } from "../../db/local";

/** 每实体一个 JSON 映射，仅记录显式提供字段，不把插入默认值当作事件版本。 */
export async function initializeIngestionVersions(db: LocalExecutor): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS ingestion_field_versions (
    project_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    versions TEXT NOT NULL, PRIMARY KEY(project_id, entity_type, entity_id))`);
}

// 同时间戳按 envelope ID 字典序决定；同时间戳且同 ID 视为重试，首个值保持不变。
// metadata/usage 等 JSON 列以整个字段为冲突单位，不递归合并内部键。
type Version = [string, string];

/** 必须在实体事务内调用，失败时版本与实体一起回滚。 */
export async function selectVersionedColumns(
  db: LocalExecutor,
  table: string,
  row: Record<string, unknown>,
  columns: string[],
  eventId: string,
  inherited: string[] = [],
): Promise<string[]> {
  const key = [row.project_id, table, row.id];
  const stored = (await db.get(
    `SELECT versions FROM ingestion_field_versions
    WHERE project_id=? AND entity_type=? AND entity_id=?`,
    ...key,
  )) as { versions: string } | undefined;
  const versions: Record<string, Version> = stored ? JSON.parse(stored.versions) : {};
  const previous = (await db.get(
    `SELECT * FROM ${table} WHERE project_id=? AND id=?`,
    row.project_id,
    row.id,
  )) as Record<string, unknown> | undefined;
  if (!stored && previous) {
    // 历史行无法判断默认值来源；保守保护所有非空值，允许补 NULL。
    for (const [column, value] of Object.entries(previous)) {
      if (value != null) versions[column] = [String(previous.event_ts ?? ""), ""];
    }
  }
  const incoming: Version = [String(row.event_ts), eventId];
  const inheritedColumns = inherited.filter(
    (column) =>
      (column === "input" || column === "output") &&
      !columns.includes(column) &&
      !versions[column] &&
      previous?.[column] == null,
  );
  const accepted = [...columns, ...inheritedColumns].filter((column) => {
    if (column === "updated_at" || column === "event_ts") return false;
    const old = versions[column];
    if (old && (old[0] > incoming[0] || (old[0] === incoming[0] && old[1] >= incoming[1]))) {
      return false;
    }
    versions[column] = incoming;
    return true;
  });
  if (!previous || String(previous.event_ts) <= incoming[0]) {
    accepted.push("event_ts", "updated_at");
  }
  await db.run(
    `INSERT INTO ingestion_field_versions VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, entity_type, entity_id) DO UPDATE SET versions=excluded.versions`,
    ...key,
    JSON.stringify(versions),
  );
  return accepted;
}
