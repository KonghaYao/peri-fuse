import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openLocalDatabase } from "../packages/shared/dist/src/db/local.js";
import {
  initializeSessionSearchSchema,
  searchTrigrams,
} from "../packages/shared/dist/src/server/session-search/schema.js";
import { SessionSearchStorage } from "../packages/shared/dist/src/server/session-search/storage.js";

const root = mkdtempSync(join(tmpdir(), "perifuse-search-bench-"));
const db = await openLocalDatabase(join(root, "search.turso.db"));
const size = Number(process.env.SIZE ?? 1000);
const runs = Number(process.env.RUNS ?? 20);
if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(runs) || runs < 1)
  throw new Error("SIZE and RUNS must be positive integers");
try {
  await initializeSessionSearchSchema(db);
  const storage = new SessionSearchStorage(db);
  const started = performance.now();
  for (let index = 0; index < size; index++) {
    await storage.indexSource(
      {
        projectId: "benchmark",
        kind: "trace",
        id: String(index),
        revision: 1,
        eventTime: new Date().toISOString(),
      },
      [
        {
          role: "user",
          text: `commonphrase ${index % 100 === 0 ? "rareneedle" : "ordinary"} ${index}`,
          order: 0,
          field: "input",
        },
      ],
    );
  }
  const buildMs = performance.now() - started;
  const results = [];
  for (const term of ["commonphrase", "rareneedle", "missingterm"]) {
    const grams = searchTrigrams(term);
    const placeholders = grams.map(() => "?").join(",");
    const sql = `SELECT text_id FROM search_trigrams WHERE project_id=? AND gram IN (${placeholders}) GROUP BY text_id HAVING count(DISTINCT gram)=?`;
    const durations = [];
    let matches = 0;
    for (let run = 0; run < runs; run++) {
      const start = performance.now();
      const candidates = await db.all(sql, "benchmark", ...grams, grams.length);
      matches = 0;
      for (const candidate of candidates) {
        const match = await db.get(
          "SELECT 1 FROM search_texts WHERE project_id=? AND text_id=? AND instr(normalized_text,?)>0",
          "benchmark",
          candidate.text_id,
          term,
        );
        if (match) matches++;
      }
      durations.push(performance.now() - start);
    }
    durations.sort((left, right) => left - right);
    results.push({
      term,
      matches,
      medianMs: durations[Math.floor(runs / 2)],
      p95Ms: durations[Math.ceil(runs * 0.95) - 1],
    });
  }
  console.log(JSON.stringify({ size, buildMs, results }, null, 2));
} finally {
  await db.close();
  rmSync(root, { recursive: true, force: true });
}
