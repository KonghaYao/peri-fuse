import { setImmediate } from "node:timers/promises";
import { INITIAL_DIGEST, nextDigest, quote, rowBytes, sourceRows } from "./source.mjs";
import { checkpoint, getState, setState } from "./target.mjs";

export function interruption() {
  const error = new Error(
    "Migration interrupted safely. Keep writers stopped and rerun the same command with --resume.",
  );
  error.code = "MIGRATION_INTERRUPTED";
  return error;
}

export async function copyTable(source, db, plan, options, stopped, log) {
  const key = `table:${plan.name}`;
  let state = (await getState(db, key)) ?? {
    cursor: null,
    copied: 0,
    digest: INITIAL_DIGEST,
    done: false,
  };
  const current = await db.get(`SELECT count(*) AS count FROM ${quote(plan.name)}`);
  if (Number(current.count) !== state.copied)
    throw new Error(`Destination row count changed unexpectedly: ${plan.name}`);
  if (state.done) return state;
  const fields = ["rowid", ...plan.columns.map((column) => column.name)];
  const limit = Math.max(1, Math.min(options.batchRows, Math.floor(900 / fields.length)));
  let batch = [];
  let bytes = 0;
  let sinceCheckpoint = 0;
  let lastLog = 0;
  const flush = async () => {
    if (!batch.length) return;
    source.assertUnchanged();
    const digest = batch.reduce((previous, row) => nextDigest(previous, row), state.digest);
    const next = {
      cursor: batch.at(-1)[0].toString(),
      copied: state.copied + batch.length,
      digest,
      done: false,
    };
    await db
      .transactionAsync(async (tx) => {
        await tx.run(
          `INSERT INTO ${quote(plan.name)}(${fields.map(quote).join(",")}) VALUES ${batch.map(() => `(${fields.map(() => "?").join(",")})`).join(",")}`,
          ...batch.flat(),
        );
        await setState(tx, key, next);
      })
      .immediate();
    state = next;
    sinceCheckpoint += bytes;
    if (sinceCheckpoint >= 32 * 1024 * 1024) {
      await checkpoint(db);
      sinceCheckpoint = 0;
    }
    batch = [];
    bytes = 0;
    if (Date.now() - lastLog >= 2000) {
      log(
        `${plan.name}: ${state.copied}/${plan.count} rows; RSS ${Math.ceil(process.memoryUsage().rss / 1024 / 1024)} MiB`,
      );
      lastLog = Date.now();
    }
    await setImmediate();
  };
  for (const row of sourceRows(source, plan, state.cursor)) {
    if (stopped()) throw interruption();
    const size = rowBytes(row);
    if (size > options.maxRowBytes)
      throw new Error(
        `Row in ${plan.name} exceeds --max-row-mib; increase the limit explicitly if enough RAM is available`,
      );
    if (batch.length && (batch.length >= limit || bytes + size > options.batchBytes)) await flush();
    if (stopped()) throw interruption();
    batch.push(row);
    bytes += size;
  }
  if (stopped()) throw interruption();
  await flush();
  if (state.copied !== plan.count) throw new Error(`Source row count mismatch: ${plan.name}`);
  state.done = true;
  await setState(db, key, state);
  await checkpoint(db);
  log(`${plan.name}: copied ${state.copied} rows`);
  return state;
}

export async function verifyTable(db, plan, stopped, log) {
  const state = await getState(db, `table:${plan.name}`);
  if (state.verified) return state;
  const statement = await db.prepare(
    `SELECT rowid,${plan.columns.map((column) => quote(column.name)).join(",")} FROM ${quote(plan.name)} ORDER BY rowid`,
  );
  statement.raw(true).safeIntegers(true);
  let digest = INITIAL_DIGEST;
  let count = 0;
  try {
    for await (const row of statement.iterate([])) {
      if (stopped()) throw interruption();
      digest = nextDigest(digest, row);
      count++;
      if (count % 1000 === 0) await setImmediate();
    }
  } finally {
    statement.close();
  }
  if (count !== state.copied || digest !== state.digest)
    throw new Error(`Content verification failed: ${plan.name}; destination will not be published`);
  state.verified = true;
  await setState(db, `table:${plan.name}`, state);
  log(`${plan.name}: verified ${count} rows (SHA-256)`);
  return state;
}

export async function rebuildTrigrams(source, db, plans, stopped, log) {
  const plan = plans.find((candidate) => candidate.name === "search_texts");
  if (!plan) return;
  let state = (await getState(db, "trigrams")) ?? { cursor: null, texts: 0, grams: 0 };
  if (state.done) return;
  const fields = ["rowid", ...plan.columns.map((column) => column.name)];
  const textOffset = fields.indexOf("normalized_text");
  const projectOffset = fields.indexOf("project_id");
  const idOffset = fields.indexOf("text_id");
  for (const row of sourceRows(source, plan, state.cursor)) {
    if (stopped()) throw interruption();
    if (Buffer.byteLength(row[textOffset]) > 128 * 1024)
      throw new Error(
        "Legacy search chunk is unexpectedly large; refusing unbounded trigram expansion",
      );
    const characters = Array.from(row[textOffset]);
    const grams = [
      ...new Set(
        characters.slice(0, -2).map((_, index) => characters.slice(index, index + 3).join("")),
      ),
    ];
    const next = {
      cursor: row[0].toString(),
      texts: state.texts + 1,
      grams: state.grams + grams.length,
    };
    await db
      .transactionAsync(async (tx) => {
        for (let offset = 0; offset < grams.length; offset += 250) {
          const batch = grams.slice(offset, offset + 250);
          await tx.run(
            `INSERT INTO search_trigrams(project_id,gram,text_id) VALUES ${batch.map(() => "(?,?,?)").join(",")}`,
            ...batch.flatMap((gram) => [row[projectOffset], gram, row[idOffset]]),
          );
        }
        await setState(tx, "trigrams", next);
      })
      .immediate();
    state = next;
    if (state.texts % 200 === 0) {
      source.assertUnchanged();
      await checkpoint(db);
      log(`search trigrams: ${state.texts}/${plan.count} texts`);
    }
    await setImmediate();
  }
  state.done = true;
  await setState(db, "trigrams", state);
  const count = await db.get("SELECT count(*) AS count FROM search_trigrams");
  if (Number(count.count) !== state.grams) throw new Error("Search trigram row count mismatch");
  log(`search trigrams: rebuilt ${state.grams} rows`);
}
