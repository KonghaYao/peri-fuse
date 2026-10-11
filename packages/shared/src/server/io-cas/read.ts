import { createHash } from "node:crypto";
import { CAS_MAX_BYTES, type ChunkSource, decodeChunk } from "./chunk-codec";
import { contentHash, equalBytes, hashToHex, ORIGINAL_HASH_DOMAIN } from "./hash";
import {
  assembleInput,
  collectRefHashes,
  MANIFEST_HEADER_BYTES,
  type Manifest,
  type ManifestRefKey,
  parseManifest,
} from "./manifest";

/**
 * `hydrateIoRows` —— codec 2（CAS manifest）行的批量装配（设计 §7.1 / §7.2 / §7.4）。
 *
 * ## 契约（已冻结，W4b 与 W5 依赖）
 *
 * 输入：调用方从**同一个只读快照**（`withReadSnapshot` 的 tx，见 `db/read-snapshot.ts`）
 * 读出的行数组。本函数只接管 `input_codec === 2` 的行：
 *
 * | 行 | 结果 |
 * | --- | --- |
 * | `input_codec === 2` | `input` 替换为完整 input 字符串，并删除 `input_codec` / `input_raw_size`（该行退出 IO codec 路径，后续 `decodeIoRow` 看到 `codec === undefined` 时按已解码跳过） |
 * | `input_codec` 为 0 / 1 / null / 缺省 | **完全不改动**，`decodeIoRow` 仍是唯一权威 |
 *
 * 行必须携带 `project_id`：池内容按项目隔离，缺失即 `IO_CAS_PROJECT_REQUIRED`（设计 §7.2
 * 步骤 2「缺投影是内部错误」的一环，另见 §D-3）。`input` 为编码 BLOB 却没有 `input_codec`
 * 的投影同样按内部错误处理（`IO_CAS_INVALID`），绝不静默跳过。
 *
 * ## 查询形状（验收：设计 §12「正文读取」）
 *
 * 按 project 收集去重后的 REF hash，每 **≤128 个（`HYDRATE_BATCH_LIMIT`）一次查表**，
 * 因此池上的额外 SQL 次数恒为 `Σ_projects ceil(unique_p / 128)`，与命中行数、token 数无关。
 * 没有任何 codec 2 行时（含 summary / output-only 等不选 `input` 的请求）**对池 0 次查询**。
 *
 * ## 预算与窗口
 *
 * 预算（`HydrateIoBudget.maxBytes`）约束本次调用的**临时解码状态**：
 * `Σ(manifest 字节 + header 声明的 body_raw_size) + Σ(本组唯一池块的 raw_size)`。
 * 前者在**任何 SQL 之前**用 header（偏移 6..9 的 u32LE）预检，超限立即 `IO_CAS_LIMIT`；
 * 后者随批量取块累加，一旦超限立刻中止，绝不进入解压。该口径不包含返回给调用方的
 * 输出字符串（那是请求本身的必要产物）。
 *
 * 单行装配的临时窗口按原文计 ≤ `windowBytes`（默认 8MiB）：窗口内的普通行直接走冻结的
 * `assembleInput`（端到端 `original_hash` 校验）；超过窗口的行按字节切片装配，用流式
 * UTF-8 解码器延续多字节序列，并以增量 `original_hash` 收尾，因此临时缓冲始终有界。
 *
 * ## 错误分类（message 即错误码）
 *
 * `IO_CAS_VERSION`（magic/version/body_codec 非法）、`IO_CAS_INVALID`（类型/投影不成立）、
 * `IO_CAS_LIMIT`（格式上限或预算超限）、`IO_CAS_MISSING`（同快照内池中缺块）、
 * `IO_CAS_CORRUPT`（长度/内容 hash/UTF-8/original_hash 不符）、
 * `IO_CAS_PROJECT_REQUIRED`（缺 `project_id`）。
 *
 * 失败时抛错前可能已改写部分行；调用方不得复用失败调用的 `rows`。
 */

/** `observations.input` 的 CAS codec 值（设计 §5.3 codec 语义表）。 */
export const IO_CAS_CODEC = 2;

/** 单次池查询允许的最大 hash 数；`batchSize` 只能收紧、不能放宽。 */
export const HYDRATE_BATCH_LIMIT = 128;

/** 单行临时解码窗口默认值（按原文 / body 字节计）。 */
export const HYDRATE_WINDOW_BYTES = 8 * 1024 * 1024;

export interface HydrateIoBudget {
  /**
   * 本次调用允许的临时解码状态上限（字节），语义见模块注释。
   * 省略时取 `HydrateIoDeps.maxBytes`（CAS 格式上限 32MiB）。
   */
  maxBytes?: number;
  /** 单行临时解码窗口（原文 / body 字节），默认 8MiB。 */
  windowBytes?: number;
  /** 每组查询的 hash 数，默认 128，硬上限 128。 */
  batchSize?: number;
}

/**
 * 快照内的最小查询接口（`Transaction` 与 `Database` 均满足）。
 * 只使用 `all`：两个本地引擎的 `all(sql, ...params)` 形状一致，`iterate` 的
 * 参数传递形状不一致（见 `db/sqlite.ts` 的 executor），因此不依赖它。
 */
export interface HydrateExecutor {
  all(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
}

/** 增量 `original_hash` 计算器（域前缀已由实现方内置）。 */
export interface HydrateOriginalHasher {
  update(bytes: Uint8Array): void;
  digest(): Uint8Array;
}

/**
 * 源码工厂的显式依赖集（**冻结契约**）。
 *
 * `makeHydrateIoRows` 的函数体会以源码字符串注入 worker（D-5 内联路线，与
 * `io-compression.ts` 的 `IO_READER_SOURCE` 同构），因此它**只**引用本对象与语言内置
 * 全局（`Buffer` / `TextDecoder` / `Map` / …），不闭包捕获 `node:crypto` / `node:zlib`
 * 或任何模块级常量。worker 侧按 `buildHydrateReaderSource` 组装出等价依赖即可复用同一份
 * 装配逻辑，无需手抄第二套 parser。
 */
export interface HydrateIoDeps {
  parseManifest(buffer: Uint8Array): Manifest;
  collectRefHashes(manifest: Manifest): ManifestRefKey[];
  assembleInput(
    manifest: Manifest,
    chunksByHex: ReadonlyMap<string, Uint8Array>,
    expectedRawSize: number,
  ): string;
  decodeChunk(chunk: ChunkSource): Uint8Array;
  contentHash(messageBytes: Uint8Array): Uint8Array;
  equalBytes(left: Uint8Array, right: Uint8Array): boolean;
  hashToHex(hash: Uint8Array): string;
  /** 新建增量 original_hash 计算器；域必须是 `peri-fuse:io-input:v1\0`。 */
  createOriginalHasher(): HydrateOriginalHasher;
  /** manifest 固定 header 长度（74）。 */
  manifestHeaderBytes: number;
  /** `body_raw_size` 的 u32LE 偏移（6），供预检在解压前读取。 */
  bodyRawSizeOffset: number;
  /** 格式层字节上限（= `CAS_MAX_BYTES`），同时作为预算默认值。 */
  maxBytes: number;
}

export type HydrateIoRows = <T extends Record<string, unknown>>(
  tx: HydrateExecutor,
  rows: T[],
  budget?: number | HydrateIoBudget,
) => Promise<T[]>;

/**
 * 构造 hydrate 的纯逻辑实例。返回值是可序列化的（见 `HydrateIoDeps` 的说明）：
 * `makeHydrateIoRows.toString()` 连同依赖表达式即可在 worker 内重建同一函数。
 */
export function makeHydrateIoRows(deps: HydrateIoDeps): HydrateIoRows {
  // 以下常量刻意留在函数体内部：整个函数体会被 toString() 注入 worker，
  // 引用任何模块级符号都会在注入后变成 ReferenceError。
  const CAS_CODEC = 2;
  const DEFAULT_BATCH = 128;
  const DEFAULT_WINDOW = 8 * 1024 * 1024;

  function normalizeBudget(budget: number | HydrateIoBudget | undefined) {
    const requested = typeof budget === "number" ? { maxBytes: budget } : budget || {};
    const maxBytes = requested.maxBytes === undefined ? deps.maxBytes : requested.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("IO_CAS_INVALID");
    const windowBytes =
      requested.windowBytes === undefined ? DEFAULT_WINDOW : requested.windowBytes;
    if (!Number.isSafeInteger(windowBytes) || windowBytes <= 0) throw new Error("IO_CAS_INVALID");
    const requestedBatch = requested.batchSize === undefined ? DEFAULT_BATCH : requested.batchSize;
    if (!Number.isSafeInteger(requestedBatch) || requestedBatch <= 0)
      throw new Error("IO_CAS_INVALID");
    return { maxBytes, windowBytes, batchSize: Math.min(requestedBatch, DEFAULT_BATCH) };
  }

  /**
   * 预检：只读 header（不解压、不解析 token），返回声明的 `body_raw_size`。
   * 错误码与 `parseManifest` 对同一条件的判定保持一致。
   */
  function readDeclaredBodySize(bytes: Uint8Array): number {
    if (bytes.byteLength > deps.maxBytes) throw new Error("IO_CAS_LIMIT");
    if (bytes.byteLength < deps.manifestHeaderBytes) throw new Error("IO_CAS_INVALID");
    if (!(bytes[0] === 0x50 && bytes[1] === 0x46 && bytes[2] === 0x49 && bytes[3] === 0x43))
      throw new Error("IO_CAS_VERSION");
    if (bytes[4] !== 1) throw new Error("IO_CAS_VERSION");
    const bodyCodec = bytes[5];
    if (bodyCodec !== 0 && bodyCodec !== 1) throw new Error("IO_CAS_VERSION");
    const offset = deps.bodyRawSizeOffset;
    const bodyRawSize =
      (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)) >>>
      0;
    if (bodyRawSize > deps.maxBytes) throw new Error("IO_CAS_LIMIT");
    return bodyRawSize;
  }

  /**
   * 超窗口装配：按字节把 token 流切成 ≤`windowBytes` 的窗口，逐窗口做流式 UTF-8 解码，
   * 同时增量累积 `original_hash`；多字节序列跨窗口时由解码器内部续接。
   */
  function assembleWindowed(
    manifest: Manifest,
    pool: ReadonlyMap<string, Uint8Array>,
    expectedRawSize: number,
    windowBytes: number,
  ): string {
    const hasher = deps.createOriginalHasher();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let pieces: Uint8Array[] = [];
    let pending = 0;
    let total = 0;
    const flush = (final: boolean) => {
      if (pending === 0) return;
      const window = Buffer.concat(pieces, pending);
      hasher.update(window);
      try {
        text += decoder.decode(window, { stream: !final });
      } catch {
        throw new Error("IO_CAS_CORRUPT");
      }
      pieces = [];
      pending = 0;
    };
    for (const token of manifest.tokens) {
      let bytes: Uint8Array;
      if (token.tag === "literal") {
        bytes = token.bytes;
      } else {
        const chunk = pool.get(deps.hashToHex(token.hash));
        if (chunk === undefined) throw new Error("IO_CAS_MISSING");
        bytes = chunk;
      }
      total += bytes.byteLength;
      // 与 assembleInput 一致：超过声明长度就不可能成立，提前中止避免超额分配。
      if (total > expectedRawSize) throw new Error("IO_CAS_CORRUPT");
      for (let offset = 0; offset < bytes.byteLength; ) {
        // windowBytes >= 1 且每轮结束时 pending < windowBytes，故 take >= 1，循环必然推进。
        const take = Math.min(windowBytes - pending, bytes.byteLength - offset);
        pieces.push(bytes.subarray(offset, offset + take));
        pending += take;
        offset += take;
        if (pending >= windowBytes) flush(false);
      }
    }
    flush(true);
    try {
      // 终点终结：上一窗口遗留的不完整序列在此显现（fatal 解码器抛错）。
      text += decoder.decode();
    } catch {
      throw new Error("IO_CAS_CORRUPT");
    }
    if (total !== expectedRawSize) throw new Error("IO_CAS_CORRUPT");
    if (!deps.equalBytes(hasher.digest(), manifest.originalHash)) throw new Error("IO_CAS_CORRUPT");
    return text;
  }

  async function hydrateIoRows(
    tx: HydrateExecutor,
    rows: Record<string, unknown>[],
    budget?: number | HydrateIoBudget,
  ): Promise<Record<string, unknown>[]> {
    if (!Array.isArray(rows)) throw new Error("IO_CAS_INVALID");
    const settings = normalizeBudget(budget);
    const targets: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== "object") throw new Error("IO_CAS_INVALID");
      const codec = row.input_codec;
      if (codec === undefined || codec === null) {
        // §D-3：选了 input（编码 BLOB）却没选 codec 列时，任何静默跳过都会让下游
        // `String(row.input)` 产出 "1,2,3,…"。缺投影是内部错误（设计 §7.2 步骤 2）。
        if (row.input instanceof Uint8Array) throw new Error("IO_CAS_INVALID");
        continue;
      }
      if (Number(codec) !== CAS_CODEC) continue;
      targets.push(row);
    }
    // 不请求 input 时对池 0 次查询。
    if (targets.length === 0) return rows;

    // 预检：SQL 之前的保守预算（manifest 字节 + header 声明的 body_raw_size）。
    let declared = 0;
    const plans: {
      row: Record<string, unknown>;
      projectId: string;
      expectedRawSize: number;
      manifest: Manifest | null;
    }[] = [];
    for (const row of targets) {
      const projectId = row.project_id;
      if (typeof projectId !== "string" || projectId.length === 0)
        throw new Error("IO_CAS_PROJECT_REQUIRED");
      const manifestBytes = row.input;
      if (!(manifestBytes instanceof Uint8Array)) throw new Error("IO_CAS_INVALID");
      const expectedRawSize = Number(row.input_raw_size);
      if (!Number.isSafeInteger(expectedRawSize) || expectedRawSize < 0)
        throw new Error("IO_CAS_INVALID");
      if (expectedRawSize > deps.maxBytes) throw new Error("IO_CAS_LIMIT");
      declared += manifestBytes.byteLength + readDeclaredBodySize(manifestBytes);
      if (declared > settings.maxBytes) throw new Error("IO_CAS_LIMIT");
      plans.push({ row, projectId, expectedRawSize, manifest: null });
    }

    // 解析 manifest（每个 manifest 只解压一次，装配阶段复用）并收集去重 REF，
    // 按 project 分组以消除 N+1；`groups` 的插入序即首次出现序，查询顺序稳定。
    const groups = new Map<string, Map<string, true>>();
    for (let index = 0; index < plans.length; index++) {
      const plan = plans[index];
      const manifest = deps.parseManifest(plan.row.input as Uint8Array);
      plan.manifest = manifest;
      let unique = groups.get(plan.projectId);
      if (unique === undefined) {
        unique = new Map();
        groups.set(plan.projectId, unique);
      }
      for (const key of deps.collectRefHashes(manifest)) unique.set(key.hex, true);
    }

    // 批量取块：每项目每批 ≤ batchSize 个 hash 一次查表，共 Σ ceil(unique/128) 次。
    // 池内容按 project 隔离存放：跨项目同 hash 绝不复用对方的内容（设计 §11 隔离）。
    const pools = new Map<string, Map<string, Uint8Array>>();
    let fetchedBytes = 0;
    for (const [projectId, unique] of groups) {
      const hexes = Array.from(unique.keys());
      const pool = new Map<string, Uint8Array>();
      pools.set(projectId, pool);
      for (let start = 0; start < hexes.length; start += settings.batchSize) {
        const batch = hexes.slice(start, start + settings.batchSize);
        const params: unknown[] = [projectId];
        const marks: string[] = [];
        for (const hex of batch) {
          marks.push("?");
          params.push(Buffer.from(hex, "hex"));
        }
        const fetched = await tx.all(
          `SELECT content_hash, codec, raw_size, payload FROM io_cas_chunks WHERE project_id = ? AND content_hash IN (${marks.join(",")})`,
          ...params,
        );
        for (const fetchedRow of fetched) {
          // 同快照内的存在性 / 类型 / 长度核对，任一不符都不进入解压。
          const hashBytes = fetchedRow.content_hash;
          if (!(hashBytes instanceof Uint8Array) || hashBytes.byteLength !== 32)
            throw new Error("IO_CAS_INVALID");
          const hex = deps.hashToHex(hashBytes);
          if (!batch.includes(hex) || pool.has(hex)) throw new Error("IO_CAS_INVALID");
          const rawSize = Number(fetchedRow.raw_size);
          if (!Number.isSafeInteger(rawSize) || rawSize < 0) throw new Error("IO_CAS_INVALID");
          fetchedBytes += rawSize;
          if (declared + fetchedBytes > settings.maxBytes) throw new Error("IO_CAS_LIMIT");
          const decoded = deps.decodeChunk({
            codec: Number(fetchedRow.codec),
            rawSize,
            payload: fetchedRow.payload as Uint8Array,
          });
          if (!deps.equalBytes(deps.contentHash(decoded), hashBytes))
            throw new Error("IO_CAS_CORRUPT");
          pool.set(hex, decoded);
        }
      }
      for (const hex of hexes) {
        if (!pool.has(hex)) throw new Error("IO_CAS_MISSING");
      }
    }

    for (const plan of plans) {
      const manifest = plan.manifest as Manifest;
      const pool = pools.get(plan.projectId) as ReadonlyMap<string, Uint8Array>;
      const windowBytes = settings.windowBytes;
      const input =
        manifest.bodyRawSize <= windowBytes && plan.expectedRawSize <= windowBytes
          ? deps.assembleInput(manifest, pool, plan.expectedRawSize)
          : assembleWindowed(manifest, pool, plan.expectedRawSize, windowBytes);
      plan.row.input = input;
      delete plan.row.input_codec;
      delete plan.row.input_raw_size;
      plan.manifest = null;
    }
    return rows;
  }

  return hydrateIoRows as HydrateIoRows;
}

/** 模块级（Node 运行时）依赖装配；worker 侧按其形状提供等价实现。 */
export const HYDRATE_IO_DEPS: HydrateIoDeps = {
  parseManifest,
  collectRefHashes,
  assembleInput,
  decodeChunk,
  contentHash,
  equalBytes,
  hashToHex,
  createOriginalHasher: () => {
    // 必须与 `hash.ts::originalHash` 完全同构：域先入，随后才是原文分片。
    const hasher = createHash("sha256").update(ORIGINAL_HASH_DOMAIN, "utf8");
    return {
      update: (bytes: Uint8Array) => {
        hasher.update(bytes);
      },
      digest: () => hasher.digest(),
    };
  },
  manifestHeaderBytes: MANIFEST_HEADER_BYTES,
  bodyRawSizeOffset: 6,
  maxBytes: CAS_MAX_BYTES,
};

export const hydrateIoRows: HydrateIoRows = makeHydrateIoRows(HYDRATE_IO_DEPS);

/**
 * 源码工厂契约（冻结，D-5 内联路线）。
 *
 * 返回可直接嵌入 worker 源码的片段：`const hydrateIoRows = (<工厂源码>)(<依赖表达式>);`。
 * `depsExpression` 必须求值为完整的 `HydrateIoDeps`——`parseManifest` / `assembleInput` /
 * `collectRefHashes` / `decodeChunk` / `contentHash` / `equalBytes` / `hashToHex` /
 * `createOriginalHasher` 与三个常量一个都不能少（`contentHash` 与 `createOriginalHasher`
 * 需要 worker 侧的 `node:crypto`，`decodeChunk` 需要 `node:zlib`，由依赖表达式注入，
 * 不得写进工厂函数体）。生成的源码与模块内 `hydrateIoRows` 行为逐字节一致。
 */
export function buildHydrateReaderSource(depsExpression: string): string {
  return `const hydrateIoRows = (${makeHydrateIoRows.toString()})(${depsExpression});`;
}
