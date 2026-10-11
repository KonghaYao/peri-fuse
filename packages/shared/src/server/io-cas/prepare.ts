import { deflateSync } from "node:zlib";
import { CHUNK_CODEC_DEFLATE, CHUNK_CODEC_RAW } from "./chunk-codec";
import { hashToHex } from "./hash";
import { type JsonSlicePlan, planJsonSlices } from "./json-slices";
import { encodeManifest, type ManifestToken } from "./manifest";

/**
 * `observations.input` 的 CAS **纯准备**（设计 §4.1 / §4.2 / §6 步骤 0）。
 *
 * 本模块不做任何 IO：切片计划、内容 hash、manifest 编码与池块压缩都在写锁之外完成
 * （W5 ①「纯准备可在写锁前完成」）。物理发布在 `write.ts`，写入决策在
 * `../adapters/io-columns-decision.ts`。
 *
 * ## 选择阈值与降级（D-10 定案）
 *
 * 阈值沿用 W2a 的 `JSON_SLICE_DEFAULT_LIMITS`（input ≥16KiB、单元素 ≥256B、REF 覆盖 ≥50%、
 * 元素 ≤10,000、深度 ≤128、manifest < 原文）。**任一条不满足即 `planJsonSlices` 返回 degrade**，
 * 调用方原样走既有的 codec 0/1 规则——因此 CAS 永远不会让存储变大，也不会夺取
 * `PERIFUSE_IO_COMPRESSION_WRITE=on` 下 codec 1 的收益：
 *
 * | 压缩开关 | CAS 开关 | input 存储 |
 * | --- | --- | --- |
 * | off | off | codec 0（现状逐字节一致） |
 * | on | off | codec 0/1（现状逐字节一致） |
 * | off | on | 候选 → codec 2；非候选 → codec 0 |
 * | on | on | 候选 → codec 2；非候选 → codec 0/1 |
 *
 * 池块的存储 codec 跟随**既有压缩开关**（同一 CPU/空间权衡）：开关 off 时池块一律
 * 明文 codec 0；on 时仅在有收益（压缩后 + 16B 开销仍更小）时使用 codec 1。
 * manifest body 的压缩由冻结的 `encodeManifest` 自行决定，不受这两个开关影响。
 *
 * ## 进程内缓存（D-8 定案）
 *
 * `CasPrepareCache` 是**进程内单例**（`getSharedCasPrepareCache`），跨写入调用复用、
 * 按项目键控，因此进程内的准备缓存总量严格 ≤ `CAS_PREPARE_CACHE_BYTES`（32MiB）——
 * 调用级缓存会在并发写批次下叠加，实例级缓存在多 adapter 下叠加，均无法给出该上界。
 * 计费口径 = 项目键 + 原文键（按 UTF-8 上界 3B/字符）+ manifest 字节 + 池块 payload 字节；
 * 超预算的条目**不再入缓存**（不做淘汰），因此 `size` 是严格上界。缓存只保存不可变的
 * 纯准备结果，命中只跳过纯准备；**池存在性确认与原文比对仍然每写必做**
 * （GC 可能刚删块，见 `write.ts`）。
 *
 * 缓存不参与正确性：池中块的存在性与内容由发布时查询/比对决定，缓存命中不构成
 * 「池里还在」的证据（W5 ⑦）。池块 codec 由首次准备时的压缩开关决定，两种 codec
 * 都在读端合法（`decodeChunk` 自适应）。
 */

/** 进程内准备缓存的硬上限（设计 §6/§7.4：总计 ≤32MiB）。 */
export const CAS_PREPARE_CACHE_BYTES = 32 * 1024 * 1024;

let sharedCache: CasPrepareCache | undefined;

/** 进程内（每进程 ≤32MiB）的共享准备缓存；首次使用时创建。 */
export function getSharedCasPrepareCache(): CasPrepareCache {
  sharedCache ??= new CasPrepareCache();
  return sharedCache;
}

/** 池块压缩的收益门槛：与既有 IO 压缩同一策略（压缩 + 16B 头开销仍更小才压）。 */
const DEFLATE_MARGIN_BYTES = 16;

/** 池内一块的写入形态；`raw` 是计划字节的只读视图（零拷贝，禁止修改）。 */
export interface PreparedChunk {
  hash: Buffer;
  codec: number;
  rawSize: number;
  payload: Uint8Array;
  raw: Uint8Array;
}

/** 一次 CAS 发布的完整纯准备结果（不可变；缓存复用安全）。 */
export interface PreparedCas {
  /** codec 2 行要写入 `observations.input` 的 manifest 字节。 */
  manifest: Buffer;
  /** `input_raw_size`：完整重组原文的 UTF-8 长度。 */
  rawSize: number;
  chunks: readonly PreparedChunk[];
  /** 去重后的内容 hash（按首次出现顺序，供池批量确认）。 */
  hashes: readonly Uint8Array[];
  refCount: number;
  literalBytes: number;
}

export interface CasPrepareOptions {
  projectId: string;
  /** 单次调用缓存；省略则不缓存。 */
  cache?: CasPrepareCache;
  /** 池块是否允许 deflate（跟随 `PERIFUSE_IO_COMPRESSION_WRITE`），默认允许。 */
  compress?: boolean;
}

/**
 * 纯准备入口：把候选 input 转成 manifest + 池块；任何降级条件返回 `undefined`。
 *
 * 非法 UTF-16 由 `planJsonSlices` 抛 `IO_TEXT_INVALID_UTF16`（与既有编码器同码），
 * 非 `string` 输入由调用方在 `io-columns-decision.ts` 拦下，不进本函数。
 */
export function prepareCasInput(
  input: string,
  options: CasPrepareOptions,
): PreparedCas | undefined {
  const cached = options.cache?.get(options.projectId, input);
  if (cached) return cached;
  const planned = planJsonSlices(input);
  if (planned.status !== "ok") return undefined;
  const plan = planned.plan;
  const prepared: PreparedCas = {
    manifest: encodeManifest(toTokens(plan), plan.bytes),
    rawSize: plan.bytes.byteLength,
    chunks: collectChunks(plan, options.compress !== false),
    hashes: [...plan.hashes],
    refCount: plan.refs.length,
    literalBytes: literalBytes(plan),
  };
  options.cache?.set(options.projectId, input, prepared);
  return prepared;
}

/** 冻结的重组顺序：`literal[0] ref[0] literal[1] ref[1] … literal[n]`。 */
function toTokens(plan: JsonSlicePlan): ManifestToken[] {
  const tokens: ManifestToken[] = [];
  for (const [index, literal] of plan.literals.entries()) {
    tokens.push({ tag: "literal", bytes: plan.bytes.subarray(literal.start, literal.end) });
    if (index >= plan.refs.length) continue;
    const ref = plan.refs[index];
    tokens.push({ tag: "ref", hash: ref.hash });
  }
  return tokens;
}

function literalBytes(plan: JsonSlicePlan): number {
  let total = 0;
  for (const literal of plan.literals) total += literal.end - literal.start;
  return total;
}

/** 按首次出现顺序去重取块；同 hash 的池内容只准备一次。 */
function collectChunks(plan: JsonSlicePlan, compress: boolean): PreparedChunk[] {
  const seen = new Set<string>();
  const chunks: PreparedChunk[] = [];
  for (const ref of plan.refs) {
    const hash = Buffer.from(ref.hash);
    const hex = hashToHex(hash);
    if (seen.has(hex)) continue;
    seen.add(hex);
    const raw = plan.bytes.subarray(ref.start, ref.end);
    let codec = CHUNK_CODEC_RAW;
    let payload: Uint8Array = raw;
    if (compress) {
      const deflated = deflateSync(raw);
      if (deflated.byteLength + DEFLATE_MARGIN_BYTES < raw.byteLength) {
        codec = CHUNK_CODEC_DEFLATE;
        payload = deflated;
      }
    }
    chunks.push({ hash, codec, rawSize: raw.byteLength, payload, raw });
  }
  return chunks;
}

/**
 * 进程内准备缓存（D-8）：跨调用复用、按项目键控、严格 ≤ `maxBytes`。
 *
 * - 键：项目 ID + 原文（同一项目内同一原文只准备一次，跨项目不共享）。
 * - 计费：`3 × (项目 ID 长度 + 原文长度) + manifest 字节 + Σ 池块 payload 字节`
 *   （原文键按 UTF-8 上界 3B/字符计，`raw` 视图由原文键共同覆盖）。
 * - 超预算的条目**不入缓存**，`size` 因此恒 ≤ `maxBytes`；不做淘汰。
 */
export class CasPrepareCache {
  private readonly entries = new Map<string, Map<string, { cost: number; value: PreparedCas }>>();
  private bytes = 0;

  constructor(private readonly maxBytes: number = CAS_PREPARE_CACHE_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("IO_CAS_INVALID");
  }

  /** 已计费的缓存字节（含键），恒 ≤ 构造时预算。 */
  get size(): number {
    return this.bytes;
  }

  get count(): number {
    let total = 0;
    for (const project of this.entries.values()) total += project.size;
    return total;
  }

  get(projectId: string, input: string): PreparedCas | undefined {
    return this.entries.get(projectId)?.get(input)?.value;
  }

  set(projectId: string, input: string, value: PreparedCas): void {
    const cost = entryCost(projectId, input, value);
    if (cost > this.maxBytes) return;
    if (this.bytes + cost > this.maxBytes) return;
    let project = this.entries.get(projectId);
    if (!project) {
      project = new Map();
      this.entries.set(projectId, project);
    }
    if (project.has(input)) return;
    project.set(input, { cost, value });
    this.bytes += cost;
  }
}

/** 保守计费：键按 UTF-8 上界 3B/字符，payload 按实际存储字节。 */
function entryCost(projectId: string, input: string, value: PreparedCas): number {
  let cost = (projectId.length + input.length) * 3 + value.manifest.byteLength;
  for (const chunk of value.chunks) cost += chunk.payload.byteLength;
  return cost;
}
