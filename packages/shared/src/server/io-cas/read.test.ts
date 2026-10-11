import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type LocalDatabase, openLocalDatabase, withLocalTransaction } from "../../db/local";
import { contentHash } from "./hash";
import { encodeManifest, type ManifestToken } from "./manifest";
import {
  buildHydrateReaderSource,
  HYDRATE_IO_DEPS,
  type HydrateExecutor,
  type HydrateIoBudget,
  hydrateIoRows,
  makeHydrateIoRows,
} from "./read";

// 与 `telemetry-drizzle/20261011092036_fresh_thaddeus_ross/migration.sql` 的 DDL 一致（W3）。
const IO_CAS_DDL = `CREATE TABLE io_cas_chunks (
  project_id text NOT NULL,
  content_hash blob NOT NULL,
  codec integer NOT NULL,
  raw_size integer NOT NULL,
  payload blob NOT NULL,
  mark_epoch integer DEFAULT 0 NOT NULL,
  created_at text DEFAULT (datetime('now')) NOT NULL,
  CONSTRAINT io_cas_chunks_pk PRIMARY KEY(project_id, content_hash),
  CONSTRAINT io_cas_chunks_content_hash_check CHECK(length(content_hash) = 32),
  CONSTRAINT io_cas_chunks_codec_check CHECK(codec IN (0, 1)),
  CONSTRAINT io_cas_chunks_raw_size_check CHECK(raw_size > 0 AND raw_size <= 33554432),
  CONSTRAINT io_cas_chunks_mark_epoch_check CHECK(mark_epoch >= 0)
)`;

type Row = Record<string, unknown>;

async function withFixture<T>(run: (db: LocalDatabase) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "perifuse-io-cas-read-"));
  const db = await openLocalDatabase(join(directory, "test.db"));
  try {
    await db.exec(IO_CAS_DDL);
    return await run(db);
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 把 messages 数组拆成「LITERAL 分隔符 + REF 元素」的 manifest 计划（与 W2a 切片同形）。 */
function messagesFixture(values: unknown[]) {
  const encoded = values.map((value) => Buffer.from(JSON.stringify(value), "utf8"));
  const text = `[${values.map((value) => JSON.stringify(value)).join(",")}]`;
  const tokens: ManifestToken[] = [{ tag: "literal", bytes: Buffer.from("[", "utf8") }];
  encoded.forEach((bytes, index) => {
    if (index > 0) tokens.push({ tag: "literal", bytes: Buffer.from(",", "utf8") });
    tokens.push({ tag: "ref", hash: contentHash(bytes) });
  });
  tokens.push({ tag: "literal", bytes: Buffer.from("]", "utf8") });
  return { encoded, text, tokens };
}

async function insertChunks(
  db: LocalDatabase,
  projectId: string,
  contents: Uint8Array[],
  options: { codec?: number; tamper?: boolean } = {},
) {
  for (const bytes of contents) {
    const codec = options.codec ?? 0;
    const payload = codec === 1 ? deflateSync(bytes) : bytes;
    await db.run(
      "INSERT INTO io_cas_chunks(project_id, content_hash, codec, raw_size, payload) VALUES(?,?,?,?,?)",
      projectId,
      contentHash(bytes),
      codec,
      bytes.byteLength,
      options.tamper ? Buffer.concat([payload, Buffer.from([0])]) : payload,
    );
  }
}

function casRow(
  projectId: string,
  fixture: { tokens: ManifestToken[]; text: string },
  options: { compress?: boolean; expectedRawSize?: number } = {},
): Row {
  const manifest = encodeManifest(fixture.tokens, Buffer.from(fixture.text, "utf8"), options);
  return {
    id: `obs-${projectId}`,
    project_id: projectId,
    input: manifest,
    input_codec: 2,
    input_raw_size: options.expectedRawSize ?? Buffer.byteLength(fixture.text, "utf8"),
    output: null,
    output_codec: 0,
    output_raw_size: 0,
  };
}

/** 在真实事务里跑 hydrate，同时统计池查询次数与错误码（失败时也保留计数）。 */
async function attempt(db: LocalDatabase, rows: Row[], budget?: number | HydrateIoBudget) {
  const counter = { all: 0 };
  const executor = (tx: unknown): HydrateExecutor => ({
    all: (sql: string, ...params: unknown[]) => {
      counter.all += 1;
      return (tx as HydrateExecutor).all(sql, ...params);
    },
  });
  try {
    const result = await withLocalTransaction(db, (tx) =>
      hydrateIoRows(executor(tx), rows, budget),
    );
    return { ok: true as const, rows: result, queries: counter.all };
  } catch (error) {
    return { ok: false as const, code: (error as Error).message, queries: counter.all };
  }
}

function distinctMessages(count: number, prefix = "m") {
  return Array.from({ length: count }, (_, index) => ({
    i: String(index),
    text: `${prefix}${index}`,
  }));
}

describe("hydrateIoRows", () => {
  it("混合 codec：只装配 codec 2，codec 0/1 行原样通过", async () => {
    await withFixture(async (db) => {
      const fixture = messagesFixture([{ role: "user", content: "hi" }]);
      await insertChunks(db, "p1", fixture.encoded);
      const plain: Row = {
        project_id: "p1",
        input: '[{"a":1}]',
        input_codec: 0,
        input_raw_size: 7,
      };
      const deflated = deflateSync(Buffer.from('[{"b":2}]', "utf8"));
      const compressed: Row = {
        project_id: "p1",
        input: deflated,
        input_codec: 1,
        input_raw_size: 7,
      };
      const cas = casRow("p1", fixture);

      const result = await attempt(db, [plain, compressed, cas]);

      expect(result.ok).toBe(true);
      expect(result.queries).toBe(1);
      expect(result.rows[0]).toEqual(plain);
      expect(result.rows[1]).toEqual(compressed);
      expect(result.rows[2].input).toBe(fixture.text);
      expect(result.rows[2].input_codec).toBeUndefined();
      expect(result.rows[2].input_raw_size).toBeUndefined();
    });
  });

  it("去重后每 ≤128 个 hash 一次查表：128→1 次、129→2 次", async () => {
    await withFixture(async (db) => {
      const atLimit = messagesFixture(distinctMessages(128));
      await insertChunks(db, "p1", atLimit.encoded);
      const exact = await attempt(db, [casRow("p1", atLimit)]);
      expect(exact.queries).toBe(1);
      expect(exact.rows[0].input).toBe(atLimit.text);

      const overLimit = messagesFixture(distinctMessages(129, "n"));
      await insertChunks(db, "p1", overLimit.encoded);
      const over = await attempt(db, [casRow("p1", overLimit)]);
      expect(over.queries).toBe(2);
      expect(over.rows[0].input).toBe(overLimit.text);

      // 去重单位是 hash 而非出现次数：同一消息出现两次仍只查 1 次。
      const repeated = messagesFixture([{ text: "dup" }, { text: "dup" }]);
      await insertChunks(db, "p1", [repeated.encoded[0]]);
      const deduped = await attempt(db, [casRow("p1", repeated)]);
      expect(deduped.queries).toBe(1);
      expect(deduped.rows[0].input).toBe(repeated.text);
    });
  });

  it("同项目多行归并到同一批查询", async () => {
    await withFixture(async (db) => {
      const first = messagesFixture([{ text: "a1" }, { text: "a2" }, { text: "a3" }]);
      const second = messagesFixture([{ text: "b1" }, { text: "b2" }]);
      await insertChunks(db, "p1", [...first.encoded, ...second.encoded]);
      const result = await attempt(db, [casRow("p1", first), casRow("p1", second)]);
      expect(result.queries).toBe(1);
      expect(result.rows.map((row) => row.input)).toEqual([first.text, second.text]);
    });
  });

  it("多 project 分组：Σ ceil(unique/128)，且内容不跨项目共用", async () => {
    await withFixture(async (db) => {
      const left = messagesFixture(distinctMessages(129));
      const right = messagesFixture(distinctMessages(129));
      await insertChunks(db, "p-left", left.encoded);
      await insertChunks(db, "p-right", right.encoded);

      const grouped = await attempt(db, [casRow("p-left", left), casRow("p-right", right)]);
      expect(grouped.queries).toBe(4);
      expect(grouped.rows.map((row) => row.input)).toEqual([left.text, right.text]);

      // 同内容的 hash 在 p-right 池中不存在：绝不能借用 p-left 的行（设计 §11 隔离）。
      const isolated = await attempt(db, [
        casRow("p-right", messagesFixture([{ i: 0, text: "m0" }])),
      ]);
      expect(isolated.ok).toBe(false);
      expect(isolated.code).toBe("IO_CAS_MISSING");
    });
  });

  it("缺块 → IO_CAS_MISSING（同快照内存在性核对）", async () => {
    await withFixture(async (db) => {
      const fixture = messagesFixture([{ role: "user" }, { role: "assistant" }]);
      await insertChunks(db, "p1", [fixture.encoded[0]]);
      const result = await attempt(db, [casRow("p1", fixture)]);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("IO_CAS_MISSING");
    });
  });

  it("损坏 → IO_CAS_CORRUPT：池内容与 hash 不符、manifest body 被篡改", async () => {
    await withFixture(async (db) => {
      const tamperedPool = messagesFixture([{ role: "user", content: "x" }]);
      await insertChunks(db, "p1", tamperedPool.encoded, { tamper: true });
      const pool = await attempt(db, [casRow("p1", tamperedPool)]);
      expect(pool.ok).toBe(false);
      expect(pool.code).toBe("IO_CAS_CORRUPT");

      const plain = messagesFixture([{ role: "user", content: "y" }]);
      await insertChunks(db, "p1", plain.encoded);
      const row = casRow("p1", plain, { compress: false });
      const manifest = Buffer.from(row.input as Uint8Array);
      manifest[manifest.byteLength - 1] ^= 0xff;
      row.input = manifest;
      const body = await attempt(db, [row]);
      expect(body.ok).toBe(false);
      expect(body.code).toBe("IO_CAS_CORRUPT");

      // input_raw_size 是端到端长度基准：差一个字节即 IO_CAS_CORRUPT。
      const mismatch = await attempt(db, [
        casRow("p1", plain, { expectedRawSize: Buffer.byteLength(plain.text, "utf8") + 1 }),
      ]);
      expect(mismatch.ok).toBe(false);
      expect(mismatch.code).toBe("IO_CAS_CORRUPT");

      // magic 非法在预检读 header 时即拒绝，池 0 次查询。
      const versionRow = casRow("p1", plain);
      const badMagic = Buffer.from(versionRow.input as Uint8Array);
      badMagic[0] = 0x00;
      versionRow.input = badMagic;
      const version = await attempt(db, [versionRow]);
      expect(version.ok).toBe(false);
      expect(version.code).toBe("IO_CAS_VERSION");
      expect(version.queries).toBe(0);
    });
  });

  it("预算超限（预检）→ IO_CAS_LIMIT，且在任何 SQL 之前", async () => {
    await withFixture(async (db) => {
      const fixture = messagesFixture([{ role: "user", content: "z" }]);
      await insertChunks(db, "p1", fixture.encoded);
      const result = await attempt(db, [casRow("p1", fixture)], { maxBytes: 16 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("IO_CAS_LIMIT");
      expect(result.queries).toBe(0);
    });
  });

  it("预算超限（取块后按 raw_size）→ IO_CAS_LIMIT，不进入解压", async () => {
    await withFixture(async (db) => {
      const fixture = messagesFixture([{ role: "user", content: "w".repeat(4096) }]);
      await insertChunks(db, "p1", fixture.encoded);
      const result = await attempt(db, [casRow("p1", fixture)], { maxBytes: 256 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("IO_CAS_LIMIT");
      expect(result.queries).toBe(1);
    });
  });

  it("缺 project_id → IO_CAS_PROJECT_REQUIRED（0 次查询）", async () => {
    await withFixture(async (db) => {
      const fixture = messagesFixture([{ role: "user" }]);
      await insertChunks(db, "p1", fixture.encoded);
      const row = casRow("p1", fixture);
      delete row.project_id;
      const result = await attempt(db, [row]);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("IO_CAS_PROJECT_REQUIRED");
      expect(result.queries).toBe(0);
    });
  });

  it("超窗口行按流式窗口装配（多字节序列跨窗口）", async () => {
    await withFixture(async (db) => {
      // 单 LITERAL：整数个 3 字节字符，windowBytes=64 必然在字符中间切断。
      const text = "中文观测".repeat(30);
      const tokens: ManifestToken[] = [{ tag: "literal", bytes: Buffer.from(text, "utf8") }];
      const literal = await attempt(db, [casRow("p1", { tokens, text })], { windowBytes: 64 });
      expect(literal.rows[0].input).toBe(text);
      expect(literal.queries).toBe(0);

      const mixed = messagesFixture([
        { role: "user", content: "中文".repeat(64) },
        { role: "assistant", content: "🙂".repeat(64) },
      ]);
      await insertChunks(db, "p1", mixed.encoded);
      // 窗口边界 65 落在 REF 内容偏移 64（64 % 3 = 1）即 3 字节字符内部。
      const windowed = await attempt(db, [casRow("p1", mixed)], { windowBytes: 65 });
      expect(windowed.rows[0].input).toBe(mixed.text);
      expect(windowed.queries).toBe(1);

      // 白盒：窗口路径不得回落到整段 assembleInput。
      const calls = { assembleInput: 0 };
      const spied = makeHydrateIoRows({
        ...HYDRATE_IO_DEPS,
        assembleInput: (...args: Parameters<typeof HYDRATE_IO_DEPS.assembleInput>) => {
          calls.assembleInput += 1;
          return HYDRATE_IO_DEPS.assembleInput(...args);
        },
      });
      await withLocalTransaction(db, (tx) =>
        spied(tx as HydrateExecutor, [casRow("p1", mixed)], { windowBytes: 65 }),
      );
      expect(calls.assembleInput).toBe(0);
      await withLocalTransaction(db, (tx) =>
        spied(tx as HydrateExecutor, [casRow("p1", mixed)], { windowBytes: 1024 * 1024 }),
      );
      expect(calls.assembleInput).toBe(1);
    });
  });

  it("无 codec 2 行（summary / output-only / 已 hydrate）→ 对池 0 次查询", async () => {
    await withFixture(async (db) => {
      const summary: Row[] = [{ id: "t1", project_id: "p1", total_cost: 1 }];
      const outputOnly: Row[] = [{ id: "o1", project_id: "p1", output: "ok", output_codec: 0 }];
      const empty = await attempt(db, [...summary, ...outputOnly]);
      expect(empty.ok).toBe(true);
      expect(empty.queries).toBe(0);
      expect(empty.rows).toEqual([...summary, ...outputOnly]);
    });
  });

  it("缺 codec 投影（BLOB input）→ IO_CAS_INVALID；null input 原样通过", async () => {
    await withFixture(async (db) => {
      const missing: Row[] = [
        { project_id: "p1", input: Buffer.from([1, 2, 3]), input_raw_size: 3 },
      ];
      const guarded = await attempt(db, missing);
      expect(guarded.ok).toBe(false);
      expect(guarded.code).toBe("IO_CAS_INVALID");
      expect(guarded.queries).toBe(0);

      const excluded: Row[] = [{ project_id: "p1", input: null, input_raw_size: null }];
      const passthrough = await attempt(db, excluded);
      expect(passthrough.ok).toBe(true);
      expect(passthrough.queries).toBe(0);
      expect(passthrough.rows).toEqual(excluded);
    });
  });

  it("重复 hydrate 幂等，第二次 0 次查询", async () => {
    await withFixture(async (db) => {
      const fixture = messagesFixture([{ role: "user", content: "again" }]);
      await insertChunks(db, "p1", fixture.encoded);
      const rows = [casRow("p1", fixture)];
      const first = await attempt(db, rows);
      const second = await attempt(db, rows);
      expect(first.queries).toBe(1);
      expect(second.queries).toBe(0);
      expect(second.rows).toBe(rows);
      expect(second.rows[0].input).toBe(fixture.text);
    });
  });

  it("源码工厂契约：注入源码可复现装配，且不引用 node:crypto / node:zlib", async () => {
    await withFixture(async (db) => {
      const fixture = messagesFixture([{ role: "user", content: "worker" }]);
      await insertChunks(db, "p1", fixture.encoded, { codec: 1 });
      const source = buildHydrateReaderSource("deps");
      expect(source).not.toMatch(/node:crypto|node:zlib|require\s*\(/);
      // 只注入源码 + 依赖表达式：工厂体不得捕获模块作用域。
      const injected = new Function("deps", `${source}\nreturn hydrateIoRows;`)(
        HYDRATE_IO_DEPS,
      ) as typeof hydrateIoRows;

      const rows = [casRow("p1", fixture)];
      const result = await withLocalTransaction(db, (tx) => injected(tx as HydrateExecutor, rows));
      expect(result[0].input).toBe(fixture.text);
    });
  });
});
