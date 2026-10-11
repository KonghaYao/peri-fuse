import { deflateSync } from "node:zlib";
import {
  CAS_MAX_BYTES,
  CHUNK_CODEC_DEFLATE,
  CHUNK_CODEC_RAW,
  type ChunkSource,
  decodeChunk,
} from "./chunk-codec";
import { bodyHash, equalBytes, HASH_BYTES, hashToHex, originalHash } from "./hash";

/**
 * codec 2（CAS manifest）字节格式，设计 §5.2。以下偏移是**已发布数据的格式语义**。
 *
 * ```
 * Header（74B）
 *   偏移  长度  字段
 *   0     4     magic = ASCII "PFIC"
 *   4     1     version u8 = 1
 *   5     1     body_codec u8 ∈ {0,1}
 *   6     4     body_raw_size u32LE（未压缩 body 字节数，≤32MiB）
 *   10    32    original_hash（域 peri-fuse:io-input:v1\0）
 *   42    32    body_hash（域 peri-fuse:io-manifest:v1\0，覆盖未压缩 body）
 * Body（body_raw_size 字节，raw 或 zlib-wrapped deflate）
 *   0     4     token_count u32LE（≤20,001）
 *   随后 token_count 个 token，无填充、无尾随字节
 *   LITERAL：tag u8=0 + length u32LE + length 个原文字节（5+length 字节）
 *   REF：    tag u8=1 + content_hash 32B（33 字节）
 * ```
 *
 * 所有数字均为小端定长整数，不经过 JS 浮点或 JSON 序列化。
 * 原文保真由 original_hash 端到端兜底：任何 LITERAL / 引用内容替换都会改变
 * 重组字节，从而在 `assembleInput` 处失败。
 */

export const MANIFEST_MAGIC = "PFIC";
export const MANIFEST_VERSION = 1;
/** 固定 header 长度（字节）。 */
export const MANIFEST_HEADER_BYTES = 74;
/** v1 token 数上限：10,000 个元素（≤10,000 REF）+ 合并后的 LITERAL。 */
export const MANIFEST_MAX_TOKENS = 20_001;
/** `body_raw_size` 在 header 中的 u32LE 偏移（设计 §5.2）。 */
export const MANIFEST_BODY_RAW_SIZE_OFFSET = 6;

const TAG_LITERAL = 0;
const TAG_REF = 1;

export interface ManifestLiteralToken {
  tag: "literal";
  /** body 解码缓冲的只读视图（零拷贝），不得修改。 */
  bytes: Uint8Array;
}

export interface ManifestRefToken {
  tag: "ref";
  /** 32B content_hash（域 peri-fuse:io-message:v1\0），body 解码缓冲的只读视图。 */
  hash: Uint8Array;
}

export type ManifestToken = ManifestLiteralToken | ManifestRefToken;

export interface Manifest {
  version: 1;
  bodyCodec: 0 | 1;
  /** 已校验的未压缩 body 长度（== 实际解码长度）。 */
  bodyRawSize: number;
  /** 完整 input 原文字节的 hash（解码缓冲的只读视图），供 `assembleInput` 端到端校验。 */
  originalHash: Uint8Array;
  /** 已校验的未压缩 body 字节 hash（解码缓冲的只读视图）。 */
  bodyHash: Uint8Array;
  tokenCount: number;
  /** 派生统计：LITERAL 字节总数与 REF 个数，供读预算与 GC 使用。 */
  literalBytes: number;
  refCount: number;
  tokens: readonly ManifestToken[];
}

export interface ManifestEncodeOptions {
  /**
   * 省略：body 经 deflate 后更小才写 body_codec=1，否则写 0（设计 §5.2「仅压缩有收益时使用」）。
   * true：强制 deflate；false：强制明文。
   */
  compress?: boolean;
}

export interface ManifestRefKey {
  hash: Uint8Array;
  /** `hashToHex(hash)`，即 `assembleInput` 的 `chunksByHex` 键。 */
  hex: string;
}

/**
 * 读侧 manifest 逻辑的显式依赖（**冻结契约**，W4b 的 reader source 依赖它）。
 *
 * 常量、hash 与 chunk 解码全部注入：`makeManifestReader` 的函数体会被 `toString()` 后
 * 注入 worker（D-5 内联路线），函数体内不得引用模块级符号。
 */
export interface ManifestReaderDeps {
  magic: string;
  version: 1;
  headerBytes: number;
  /** `body_raw_size` 的 u32LE 偏移（6）。 */
  bodyRawSizeOffset: number;
  maxTokens: number;
  maxBytes: number;
  hashBytes: number;
  decodeChunk(chunk: ChunkSource): Uint8Array;
  bodyHash(bodyBytes: Uint8Array): Uint8Array;
  originalHash(inputBytes: Uint8Array): Uint8Array;
  equalBytes(left: Uint8Array, right: Uint8Array): boolean;
  hashToHex(hash: Uint8Array): string;
}

export interface ManifestReader {
  parseManifest(buffer: Uint8Array): Manifest;
  assembleInput(
    manifest: Manifest,
    chunksByHex: ReadonlyMap<string, Uint8Array>,
    expectedRawSize: number,
  ): string;
  collectRefHashes(manifest: Manifest): ManifestRefKey[];
}

/**
 * 编码 manifest（设计 §5.2 的写入端）。
 *
 * `originalBytes` 必须是随后写入 `observations.input` 的原文的精确 UTF-8 字节：
 * header 的 original_hash 与 `input_raw_size` 都源自同一份字节。
 * 编码不校验 token 与原文的对应关系（REF 只有 hash），该一致性由 W2a 切片计划保证。
 *
 * 错误码：token 形状/类型非法、hash 非 32B → `IO_CAS_INVALID`；
 * token 数超过 `MANIFEST_MAX_TOKENS`、body 或原文超过 32MiB → `IO_CAS_LIMIT`。
 */
export function encodeManifest(
  tokens: readonly ManifestToken[],
  originalBytes: Uint8Array,
  options: ManifestEncodeOptions = {},
): Buffer {
  if (!(originalBytes instanceof Uint8Array)) throw new Error("IO_CAS_INVALID");
  if (originalBytes.byteLength > CAS_MAX_BYTES) throw new Error("IO_CAS_LIMIT");
  const body = encodeManifestBody(tokens);
  let bodyCodec: 0 | 1 = CHUNK_CODEC_RAW;
  let payload: Uint8Array = body;
  if (options.compress !== false) {
    const deflated = deflateSync(body);
    if (options.compress === true || deflated.byteLength < body.byteLength) {
      bodyCodec = CHUNK_CODEC_DEFLATE;
      payload = deflated;
    }
  }
  const header = Buffer.allocUnsafe(MANIFEST_HEADER_BYTES);
  header.write(MANIFEST_MAGIC, 0, "ascii");
  header.writeUInt8(MANIFEST_VERSION, 4);
  header.writeUInt8(bodyCodec, 5);
  header.writeUInt32LE(body.byteLength, MANIFEST_BODY_RAW_SIZE_OFFSET);
  originalHash(originalBytes).copy(header, 10);
  bodyHash(body).copy(header, 42);
  return Buffer.concat([header, payload], MANIFEST_HEADER_BYTES + payload.byteLength);
}

/** 编码未压缩 body：token_count u32LE + 顺序 token（不加填充）。 */
function encodeManifestBody(tokens: readonly ManifestToken[]): Buffer {
  if (!Array.isArray(tokens)) throw new Error("IO_CAS_INVALID");
  if (tokens.length > MANIFEST_MAX_TOKENS) throw new Error("IO_CAS_LIMIT");
  let size = 4;
  for (const token of tokens) {
    if (token?.tag === "literal" && token.bytes instanceof Uint8Array)
      size += 5 + token.bytes.byteLength;
    else if (
      token?.tag === "ref" &&
      token.hash instanceof Uint8Array &&
      token.hash.byteLength === HASH_BYTES
    )
      size += 1 + HASH_BYTES;
    else throw new Error("IO_CAS_INVALID");
  }
  if (size > CAS_MAX_BYTES) throw new Error("IO_CAS_LIMIT");
  const body = Buffer.allocUnsafe(size);
  body.writeUInt32LE(tokens.length, 0);
  let offset = 4;
  for (const token of tokens) {
    if (token.tag === "literal") {
      body.writeUInt8(TAG_LITERAL, offset);
      body.writeUInt32LE(token.bytes.byteLength, offset + 1);
      offset += 5;
      body.set(token.bytes, offset);
      offset += token.bytes.byteLength;
    } else {
      body.writeUInt8(TAG_REF, offset);
      body.set(token.hash, offset + 1);
      offset += 1 + HASH_BYTES;
    }
  }
  return body;
}

/**
 * 构造读侧 manifest 运行时（纯逻辑实例，依赖显式注入）。
 *
 * 与模块级导出的 `parseManifest` / `assembleInput` / `collectRefHashes` 行为逐字节一致；
 * 仅作用域来源不同（`deps` 而非模块常量）。
 */
export function makeManifestReader(deps: ManifestReaderDeps): ManifestReader {
  // token tag 与最小长度就地定义：整个函数体会被 toString() 注入 worker，
  // 引用模块级符号（TAG_LITERAL / MANIFEST_MIN_BYTES）会在注入后变成 ReferenceError。
  const LITERAL_TAG = 0;
  const REF_TAG = 1;
  const MIN_BYTES = deps.headerBytes + 4;

  /** 零拷贝 Buffer 视图，用于定长整数读取与 payload 拷贝。 */
  function view(bytes: Uint8Array): Buffer {
    return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  }

  /**
   * 严格解析 manifest，同步纯函数（设计 §7.1）。任何异常输入都抛错，
   * **不返回空数组、null 或半截结果**。
   *
   * 校验顺序与错误码：
   * 1. 非 `Uint8Array`、长度低于最小合法值 → `IO_CAS_INVALID`
   * 2. 总长超过上限 → `IO_CAS_LIMIT`
   * 3. magic 非法、version 不符、body_codec ∉ {0,1} → `IO_CAS_VERSION`
   * 4. body_raw_size 超上限 → `IO_CAS_LIMIT`
   * 5. body 有界解码失败（长度不符 / inflate 失败 / 压缩输入未消费完）→ `IO_CAS_CORRUPT`
   * 6. body_hash 不符 → `IO_CAS_CORRUPT`
   * 7. token 层结构非法（tag 未知、长度越界、尾随字节、token_count 不符）→ `IO_CAS_INVALID`
   * 8. token_count 超上限 → `IO_CAS_LIMIT`
   */
  function parseManifest(buffer: Uint8Array): Manifest {
    if (!(buffer instanceof Uint8Array)) throw new Error("IO_CAS_INVALID");
    if (buffer.byteLength < MIN_BYTES) throw new Error("IO_CAS_INVALID");
    if (buffer.byteLength > deps.maxBytes) throw new Error("IO_CAS_LIMIT");
    const header = view(buffer);
    if (header.toString("latin1", 0, 4) !== deps.magic) throw new Error("IO_CAS_VERSION");
    if (header.readUInt8(4) !== deps.version) throw new Error("IO_CAS_VERSION");
    const bodyCodec = header.readUInt8(5);
    if (bodyCodec !== 0 && bodyCodec !== 1) throw new Error("IO_CAS_VERSION");
    const bodyRawSize = header.readUInt32LE(deps.bodyRawSizeOffset);
    if (bodyRawSize > deps.maxBytes) throw new Error("IO_CAS_LIMIT");
    const declaredOriginalHash = header.subarray(10, 42);
    const declaredBodyHash = header.subarray(42, deps.headerBytes);
    const body = deps.decodeChunk({
      codec: bodyCodec,
      rawSize: bodyRawSize,
      payload: header.subarray(deps.headerBytes),
    });
    if (!deps.equalBytes(deps.bodyHash(body), declaredBodyHash)) throw new Error("IO_CAS_CORRUPT");
    const bodyView = view(body);
    if (bodyView.byteLength < 4) throw new Error("IO_CAS_INVALID");
    const tokenCount = bodyView.readUInt32LE(0);
    if (tokenCount > deps.maxTokens) throw new Error("IO_CAS_LIMIT");
    const tokens: ManifestToken[] = [];
    let literalBytes = 0;
    let refCount = 0;
    let offset = 4;
    for (let index = 0; index < tokenCount; index++) {
      if (offset >= bodyView.byteLength) throw new Error("IO_CAS_INVALID");
      const tag = bodyView.readUInt8(offset);
      offset += 1;
      if (tag === LITERAL_TAG) {
        if (offset + 4 > bodyView.byteLength) throw new Error("IO_CAS_INVALID");
        const length = bodyView.readUInt32LE(offset);
        offset += 4;
        if (offset + length > bodyView.byteLength) throw new Error("IO_CAS_INVALID");
        tokens.push({ tag: "literal", bytes: bodyView.subarray(offset, offset + length) });
        literalBytes += length;
        offset += length;
      } else if (tag === REF_TAG) {
        if (offset + deps.hashBytes > bodyView.byteLength) throw new Error("IO_CAS_INVALID");
        tokens.push({ tag: "ref", hash: bodyView.subarray(offset, offset + deps.hashBytes) });
        refCount += 1;
        offset += deps.hashBytes;
      } else {
        throw new Error("IO_CAS_INVALID");
      }
    }
    if (offset !== bodyView.byteLength) throw new Error("IO_CAS_INVALID");
    return {
      version: deps.version,
      bodyCodec: bodyCodec as 0 | 1,
      bodyRawSize,
      originalHash: declaredOriginalHash,
      bodyHash: declaredBodyHash,
      tokenCount,
      literalBytes,
      refCount,
      tokens,
    };
  }

  /**
   * 按 token 顺序重组完整原文，同步纯函数（设计 §7.1 / §7.2）。
   *
   * 三重收尾校验，任一失败即抛错，绝不返回半截 input：
   * 1. 拼接字节数必须等于 `input_raw_size`（调用方从 observations 行投影，必填）；
   * 2. 拼装结果必须是可往返的 UTF-8；
   * 3. `original_hash` 必须与重组字节一致（覆盖 LITERAL 与全部 REF 内容）。
   *
   * `chunksByHex` 以 `hashToHex(content_hash)` 为键（见 `collectRefHashes`），
   * 值为池内已解码的原始字节；缺失键报 `IO_CAS_MISSING`，不静默跳过。
   * 单项内容的 hash 校验由调用方在取块时完成（设计 §7.2 步骤 4）；
   * 本函数提供的是端到端兜底。
   *
   * 错误码：`expectedRawSize` 非安全整数 → `IO_CAS_INVALID`；超上限 → `IO_CAS_LIMIT`；
   * 缺块 → `IO_CAS_MISSING`；拼装长度不符 / UTF-8 不可往返 / original_hash 不符
   * → `IO_CAS_CORRUPT`。
   */
  function assembleInput(
    manifest: Manifest,
    chunksByHex: ReadonlyMap<string, Uint8Array>,
    expectedRawSize: number,
  ): string {
    if (!Number.isSafeInteger(expectedRawSize) || expectedRawSize < 0)
      throw new Error("IO_CAS_INVALID");
    if (expectedRawSize > deps.maxBytes) throw new Error("IO_CAS_LIMIT");
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const token of manifest.tokens) {
      let bytes: Uint8Array;
      if (token.tag === "literal") {
        bytes = token.bytes;
      } else {
        const chunk = chunksByHex.get(deps.hashToHex(token.hash));
        if (chunk === undefined) throw new Error("IO_CAS_MISSING");
        if (!(chunk instanceof Uint8Array)) throw new Error("IO_CAS_INVALID");
        bytes = chunk;
      }
      total += bytes.byteLength;
      // 一旦超过声明长度就不可能成立，提前中止同时避免了超预期分配。
      if (total > expectedRawSize) throw new Error("IO_CAS_CORRUPT");
      parts.push(bytes);
    }
    if (total !== expectedRawSize) throw new Error("IO_CAS_CORRUPT");
    const assembled = Buffer.concat(parts, total);
    const text = assembled.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(assembled)) throw new Error("IO_CAS_CORRUPT");
    if (!deps.equalBytes(deps.originalHash(assembled), manifest.originalHash))
      throw new Error("IO_CAS_CORRUPT");
    return text;
  }

  /**
   * 按首次出现顺序返回去重后的 REF 键，供批量查表与 `assembleInput` 建图使用。
   * 去重单位是 hash 字节（hex 键），不是消息出现次数。
   */
  function collectRefHashes(manifest: Manifest): ManifestRefKey[] {
    const seen = new Set<string>();
    const keys: ManifestRefKey[] = [];
    for (const token of manifest.tokens) {
      if (token.tag !== "ref") continue;
      const hex = deps.hashToHex(token.hash);
      if (seen.has(hex)) continue;
      seen.add(hex);
      keys.push({ hash: token.hash, hex });
    }
    return keys;
  }

  return { parseManifest, assembleInput, collectRefHashes };
}

const MANIFEST_READER = makeManifestReader({
  magic: MANIFEST_MAGIC,
  version: MANIFEST_VERSION,
  headerBytes: MANIFEST_HEADER_BYTES,
  bodyRawSizeOffset: MANIFEST_BODY_RAW_SIZE_OFFSET,
  maxTokens: MANIFEST_MAX_TOKENS,
  maxBytes: CAS_MAX_BYTES,
  hashBytes: HASH_BYTES,
  decodeChunk,
  bodyHash,
  originalHash,
  equalBytes,
  hashToHex,
});

export const parseManifest = MANIFEST_READER.parseManifest;
export const assembleInput = MANIFEST_READER.assembleInput;
export const collectRefHashes = MANIFEST_READER.collectRefHashes;
