import {
  CAS_MAX_BYTES,
  CHUNK_CODEC_DEFLATE,
  CHUNK_CODEC_RAW,
  makeChunkCodecRuntime,
} from "./chunk-codec";
import {
  BODY_HASH_DOMAIN,
  CONTENT_HASH_DOMAIN,
  HASH_BYTES,
  makeHashRuntime,
  ORIGINAL_HASH_DOMAIN,
} from "./hash";
import {
  MANIFEST_BODY_RAW_SIZE_OFFSET,
  MANIFEST_HEADER_BYTES,
  MANIFEST_MAGIC,
  MANIFEST_MAX_TOKENS,
  MANIFEST_VERSION,
  makeManifestReader,
} from "./manifest";
import { buildHydrateReaderSource, HYDRATE_WINDOW_BYTES, IO_CAS_CODEC } from "./read";

/**
 * 读消费者的自包含源码工厂（设计 §7.1，D-5 内联路线）。
 *
 * ## 为什么是"源码工厂"而不是"再写一份 parser"
 *
 * 生产读链有三条独立执行环境：adapter 主线程、`sqlite-read-worker-source.ts` 的
 * eval worker、以及构建产物（CLI 的 `dist/server.cjs` + `dist/src/db/local.js`）。
 * 设计禁止手抄第二套 CAS parser，因此 worker 侧的 `hydrateIoRows` 与全部依赖都由
 * **本模块在运行时生成**：
 *
 * - 函数体来自 `makeHashRuntime` / `makeChunkCodecRuntime` / `makeManifestReader`
 *   的 `toString()`（与 W4a `buildHydrateReaderSource` 同构）；
 * - 常量与域前缀取自本模块 import 的冻结值，用 `JSON.stringify` 内联，杜绝手工复制；
 * - `node:crypto` / `node:zlib` 由生成的依赖表达式 `require` 注入，
 *   不进入函数体（函数体只引用 `deps` 与语言全局）。
 *
 * 生成结果必须同时满足：`new Function` 直接执行、eval worker 内执行、
 * esbuild bundle 后仍能执行（三者都在 W4b 的验证范围内）。
 */

/**
 * 一次读请求的 hydrate 预算（**调用方必须显式传入**，见 W4a 契约）。
 *
 * `maxBytes` 约束本次调用的临时解码状态（manifest + body + 池块），取 CAS 格式上限
 * 32MiB；`windowBytes` 是单行装配窗口（按原文计）8MiB。两个值都来自冻结常量，
 * 不在读路径上二次调参。
 */
export const IO_CAS_READ_BUDGET = {
  maxBytes: CAS_MAX_BYTES,
  windowBytes: HYDRATE_WINDOW_BYTES,
} as const;

/** 生成 `hydrateIoRows` 的自包含源码（含 hash / chunk / manifest 三个运行时）。 */
export function buildCasReaderSource(): string {
  return [
    // 注入点固定用 `require`：worker 是 CJS eval 上下文，与既有 IO_READER_SOURCE 一致。
    'const __casCreateHash = require("node:crypto").createHash;',
    'const __casInflateSync = require("node:zlib").inflateSync;',
    `const __casHash = (${makeHashRuntime.toString()})({ createHash: __casCreateHash, contentDomain: ${JSON.stringify(CONTENT_HASH_DOMAIN)}, originalDomain: ${JSON.stringify(ORIGINAL_HASH_DOMAIN)}, bodyDomain: ${JSON.stringify(BODY_HASH_DOMAIN)}, hashBytes: ${HASH_BYTES} });`,
    `const __casChunk = (${makeChunkCodecRuntime.toString()})({ inflate: (payload, options) => __casInflateSync(payload, options), rawCodec: ${CHUNK_CODEC_RAW}, deflateCodec: ${CHUNK_CODEC_DEFLATE}, maxBytes: ${CAS_MAX_BYTES} });`,
    `const __casManifest = (${makeManifestReader.toString()})({ magic: ${JSON.stringify(MANIFEST_MAGIC)}, version: ${MANIFEST_VERSION}, headerBytes: ${MANIFEST_HEADER_BYTES}, bodyRawSizeOffset: ${MANIFEST_BODY_RAW_SIZE_OFFSET}, maxTokens: ${MANIFEST_MAX_TOKENS}, maxBytes: ${CAS_MAX_BYTES}, hashBytes: ${HASH_BYTES}, decodeChunk: __casChunk.decodeChunk, bodyHash: __casHash.bodyHash, originalHash: __casHash.originalHash, equalBytes: __casHash.equalBytes, hashToHex: __casHash.hashToHex });`,
    buildHydrateReaderSource(
      `{ parseManifest: __casManifest.parseManifest, collectRefHashes: __casManifest.collectRefHashes, assembleInput: __casManifest.assembleInput, decodeChunk: __casChunk.decodeChunk, contentHash: __casHash.contentHash, equalBytes: __casHash.equalBytes, hashToHex: __casHash.hashToHex, createOriginalHasher: __casHash.createOriginalHasher, manifestHeaderBytes: ${MANIFEST_HEADER_BYTES}, bodyRawSizeOffset: ${MANIFEST_BODY_RAW_SIZE_OFFSET}, maxBytes: ${CAS_MAX_BYTES} }`,
    ),
  ].join("\n");
}

/** 未读取正文的行集不需要 CAS 解析能力，这里的 deps 只在命中 codec 2 时使用。 */
export interface IoRowsGuardDeps {
  casCodec: number;
  /**
   * 引擎不具备读快照能力时抛门禁错误（`PERIFUSE_READ_SNAPSHOT_UNSUPPORTED`）。
   * 具备能力时返回，随后由守卫报出"未 hydrate 的 CAS 行"这一契约违反。
   */
  assertSnapshotSupported(): void;
}

/**
 * 读路径守卫：**任何未解码的正文行都不得离开读层**（D-3）。
 *
 * 覆盖两个静默损坏入口：
 * 1. `input` / `output` 仍是 BLOB 却没有对应 codec 列——`decodeIoRow` 会静默跳过，
 *    下游 `String(row.input)` 产出 `"1,2,3,…"`；这里按内部错误 `IO_CAS_INVALID` 拒绝。
 * 2. codec 2 行未被 hydrate 就返回——NO-GO 引擎上报读快照门禁错误，
 *    具备快照能力时说明 hydrate 被跳过，同样是 `IO_CAS_INVALID`。
 */
export function makeIoRowsGuard(deps: IoRowsGuardDeps) {
  function guardIoRows(rows: readonly Record<string, unknown>[]): void {
    for (const row of rows) {
      if (row === null || typeof row !== "object") throw new Error("IO_CAS_INVALID");
      for (const field of ["input", "output"]) {
        if (!(field in row)) continue;
        const codec = row[`${field}_codec`];
        if (Number(codec) === deps.casCodec) {
          deps.assertSnapshotSupported();
          throw new Error("IO_CAS_INVALID");
        }
        if (codec === undefined && row[field] instanceof Uint8Array)
          throw new Error("IO_CAS_INVALID");
      }
    }
  }

  return guardIoRows;
}

/**
 * 生成守卫源码：`const guardIoRows = (<工厂>)({ casCodec: 2, assertSnapshotSupported });`。
 *
 * `assertSnapshotSupportedExpression` 是求值为零参函数的 JS 表达式（worker 侧为
 * `() => assertReadSnapshotSupported(db)`）；codec 值由冻结常量内联，不手工复制。
 */
export function buildIoRowsGuardSource(assertSnapshotSupportedExpression: string): string {
  return `const guardIoRows = (${makeIoRowsGuard.toString()})({ casCodec: ${IO_CAS_CODEC}, assertSnapshotSupported: ${assertSnapshotSupportedExpression} });`;
}

/**
 * 单行结果字节口径（与既有 adapter / worker 完全一致）：
 * `64 + Σ(键长 * 2 + 32 + 值成本)`，字符串按 UTF-16 单元 * 2、BLOB 按 `byteLength`、其余 8。
 *
 * 读路径在**收集原始行**与**返回解码行**两个位置用同一口径计费，避免两处漂移。
 */
export function makeIoRowWeigher() {
  function weighIoRow(row: Record<string, unknown>): number {
    let bytes = 64;
    for (const [key, value] of Object.entries(row)) {
      bytes += key.length * 2 + 32;
      bytes +=
        typeof value === "string"
          ? value.length * 2
          : value instanceof Uint8Array
            ? value.byteLength
            : 8;
    }
    return bytes;
  }

  return weighIoRow;
}

export const weighIoRow = makeIoRowWeigher();

/** 生成计费函数源码（与主线程共用同一实现）。 */
export function buildIoRowWeigherSource(): string {
  return `const weighIoRow = (${makeIoRowWeigher.toString()})();`;
}
