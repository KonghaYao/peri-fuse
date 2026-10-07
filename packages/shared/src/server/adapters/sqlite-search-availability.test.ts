import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openLocalDatabase } from "../../db/local";
import { isSessionSearchAvailable } from "../session-search/schema";
import { SQLiteTelemetryAdapter } from "./sqlite-telemetry-adapter";

it("rejects legacy files without changing their contents", async () => {
  const directory = mkdtempSync(join(tmpdir(), "peri-legacy-db-"));
  const file = join(directory, "telemetry.db");
  const legacy = await openLocalDatabase(file);
  await legacy.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('preserve')");
  await legacy.close();
  const before = readFileSync(file);
  const adapter = new SQLiteTelemetryAdapter(file);
  try {
    await expect(adapter.initialize()).rejects.toThrow("legacy database");
  } finally {
    await adapter.close();
  }
  expect(readFileSync(file)).toEqual(before);
  rmSync(directory, { recursive: true, force: true });
});

it("creates and reopens a complete non-FTS search schema", async () => {
  const directory = mkdtempSync(join(tmpdir(), "peri-search-schema-"));
  const file = join(directory, "telemetry.turso.db");
  for (let iteration = 0; iteration < 2; iteration++) {
    const adapter = new SQLiteTelemetryAdapter(file);
    try {
      await adapter.initialize();
      expect(await isSessionSearchAvailable(adapter.getDatabase())).toBe(true);
      expect(
        await adapter.getDatabase().get("SELECT name FROM sqlite_master WHERE name='search_fts'"),
      ).toBeUndefined();
    } finally {
      await adapter.close();
    }
  }
  rmSync(directory, { recursive: true, force: true });
});
