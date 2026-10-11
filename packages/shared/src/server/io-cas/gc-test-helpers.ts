import type { LocalDatabase } from "../../db/local";
import { registerReadSnapshot } from "../../db/read-snapshot";
import { decodeChunk } from "./chunk-codec";
import { hashToHex } from "./hash";
import { assembleInput, collectRefHashes, parseManifest } from "./manifest";

/**
 * W6 GC 隔离测试的共享夹具：门禁模拟、池/状态查询与"在用内容零误删"断言。
 * 本文件不是测试（不以 `.test.ts` 结尾）。
 */

/**
 * 隔离测试跑在 Turso 引擎（W1 NO-GO）。生产 GO 引擎（`PERIFUSE_ENGINE=sqlite`）在
 * `db/sqlite.ts` 里按同一契约注册 supported provider；这里为测试库注册等价能力，
 * 只用于让 GC 的门禁放行（GC 自身只走 immediate 写事务，不依赖快照实现）。
 */
export function simulateVerifiedEngine(db: LocalDatabase): void {
  registerReadSnapshot(db, {
    engine: "turso",
    supported: true,
    run: (callback) => db.transactionAsync(async (tx) => callback(tx)).deferred(),
  });
}

export interface PoolChunk {
  hex: string;
  codec: number;
  rawSize: number;
  payload: Uint8Array;
  markEpoch: number;
}

export async function poolChunks(
  db: LocalDatabase,
  projectId: string,
): Promise<Map<string, PoolChunk>> {
  const rows = (await db.all(
    "SELECT content_hash, codec, raw_size, payload, mark_epoch FROM io_cas_chunks WHERE project_id = ?",
    projectId,
  )) as Record<string, unknown>[];
  const chunks = new Map<string, PoolChunk>();
  for (const row of rows) {
    const payload = row.payload;
    const hash = row.content_hash;
    if (!(payload instanceof Uint8Array) || !(hash instanceof Uint8Array))
      throw new Error("bad pool");
    chunks.set(hashToHex(hash), {
      hex: hashToHex(hash),
      codec: Number(row.codec),
      rawSize: Number(row.raw_size),
      payload,
      markEpoch: Number(row.mark_epoch),
    });
  }
  return chunks;
}

export interface RawGcState {
  epoch: number;
  phase: string;
  rootCursor: string | null;
  sweepCursor: Uint8Array | null;
  lastError: string | null;
}

export async function rawGcState(db: LocalDatabase, projectId: string): Promise<RawGcState | null> {
  const row = (await db.get(
    "SELECT epoch, phase, root_cursor, sweep_cursor, last_error FROM io_cas_gc_state WHERE project_id = ?",
    projectId,
  )) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    epoch: Number(row.epoch),
    phase: String(row.phase),
    rootCursor: row.root_cursor === null ? null : String(row.root_cursor),
    sweepCursor: row.sweep_cursor instanceof Uint8Array ? row.sweep_cursor : null,
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

/**
 * 「零误删」断言：每个 codec 2 根引用的池内容都存在，且重组出的正文与期望逐字节一致；
 * 根集合也必须与期望一致（不多不少）。
 */
export async function assertRootsIntact(
  db: LocalDatabase,
  projectId: string,
  expected: ReadonlyMap<string, string>,
): Promise<void> {
  const pool = await poolChunks(db, projectId);
  const decoded = new Map<string, Uint8Array>();
  for (const [hex, chunk] of pool)
    decoded.set(
      hex,
      decodeChunk({ codec: chunk.codec, rawSize: chunk.rawSize, payload: chunk.payload }),
    );
  const rows = (await db.all(
    "SELECT id, input, input_codec, input_raw_size FROM observations WHERE project_id = ?",
    projectId,
  )) as Record<string, unknown>[];
  const seen = new Set<string>();
  for (const row of rows) {
    if (Number(row.input_codec) !== 2) continue;
    const id = String(row.id);
    seen.add(id);
    const buffer = row.input;
    if (!(buffer instanceof Uint8Array))
      throw new Error(`root ${id} 的 input 不是 BLOB（codec 2）`);
    const manifest = parseManifest(buffer);
    for (const key of collectRefHashes(manifest)) {
      if (!pool.has(key.hex))
        throw new Error(`GC 误删在用内容: project=${projectId} root=${id} chunk=${key.hex}`);
    }
    const wanted = expected.get(id);
    if (wanted === undefined) throw new Error(`出现未记录的 codec 2 根: ${id}`);
    const text = assembleInput(manifest, decoded, Number(row.input_raw_size));
    if (text !== wanted) throw new Error(`根 ${id} 重组正文与期望不一致`);
  }
  for (const id of expected.keys()) {
    if (!seen.has(id)) throw new Error(`在用根丢失: ${id}`);
  }
}
