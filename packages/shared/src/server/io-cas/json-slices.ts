import crypto from "node:crypto";

/**
 * observations.input 消息级 CAS 的原文切片扫描器（设计 §4.1 / §4.2）。
 *
 * 对 `string` input 先做 UTF-16 合法性检查，再转 UTF-8 字节做一次线性扫描，验证完整 JSON 语法，
 * 定位「顶层数组」或「顶层对象中唯一的 messages 数组」，输出以 `[start, end)` 区间描述的 REF
 * （消息元素原文）与 LITERAL（其余原文）切片计划。不构建 AST、不重新序列化、不写库、无 IO。
 *
 * 冻结契约（W2a 交付，W4a / W5 / W6 / W7 的唯一依据）：
 * - 输入 `string`，输出 `JsonSliceResult`：`ok` 携带 `JsonSlicePlan`，否则 `degrade` + 原因。
 * - 重组顺序固定 `literal[0] ref[0] literal[1] ref[1] … literal[n]`，且 `literals.length === refs.length + 1`，
 *   按该顺序拼接等于原始 UTF-8 字节。
 * - `refs[i].hash` / `hashes` 是设计 §5.1 的 message 域内容 hash，域前缀见 `IO_MESSAGE_HASH_DOMAIN`。
 * - 不可切分 / 超预算一律 `degrade`，绝不半截输出；非法 UTF-16 抛错，不用降级掩盖。
 */

/** 消息内容 hash 的域分隔前缀（设计 §5.1）。W2b 的 `hash.ts` 必须与此字节一致。 */
export const IO_MESSAGE_HASH_DOMAIN = "peri-fuse:io-message:v1\0";

/** 写入选择阈值（设计 §4.1 末段）。只是写入策略，不改变数据格式语义。 */
export interface JsonSliceLimits {
  /** input UTF-8 字节数下限，默认 16KiB。 */
  minInputBytes: number;
  /** input UTF-8 字节数上限，默认 32MiB（沿用 IO_MAX_BYTES）。 */
  maxInputBytes: number;
  /** 单个候选元素字节数下限，默认 256B；更小的元素留在 LITERAL。 */
  minElementBytes: number;
  /** REF 覆盖字节占 input 的比例下限，默认 0.5。 */
  minRefRatio: number;
  /** messages 数组元素个数上限，默认 10,000。 */
  maxElements: number;
  /** 容器嵌套深度上限，默认 128（顶层值若是容器则深度为 1）。 */
  maxDepth: number;
  /** token 数上限，默认 20,001（= 2 × 10,000 + 1）。 */
  maxTokens: number;
  /** 未压缩 manifest 全长度上限，默认 32MiB。 */
  maxManifestBytes: number;
  /** 是否要求未压缩 manifest 严格小于 input 字节数，默认 true。 */
  requireManifestSmaller: boolean;
}

/** 设计 §4.1 末段的初始阈值。 */
export const JSON_SLICE_DEFAULT_LIMITS: JsonSliceLimits = {
  minInputBytes: 16 * 1024,
  maxInputBytes: 32 * 1024 * 1024,
  minElementBytes: 256,
  minRefRatio: 0.5,
  maxElements: 10_000,
  maxDepth: 128,
  maxTokens: 20_001,
  maxManifestBytes: 32 * 1024 * 1024,
  requireManifestSmaller: true,
};

/** 降级枚举（冻结；§4.2 规则表 + §4.1 预算）。 */
export type JsonSliceDegradeReason =
  | "input-too-large"
  | "input-too-small"
  | "not-json"
  | "unsupported-shape"
  | "duplicate-messages-key"
  | "too-many-elements"
  | "too-deep"
  | "no-candidate"
  | "refs-below-ratio"
  | "token-budget-exceeded"
  | "manifest-too-large"
  | "manifest-not-smaller";

/** 半开字节区间 `[start, end)`，指向 `JsonSlicePlan.bytes`。 */
export interface SliceRange {
  readonly start: number;
  readonly end: number;
}

/** 单个 REF：消息元素 JSON 值原文区间 + 内容 hash。同一原文出现多次则保留多个 REF。 */
export interface SliceRef extends SliceRange {
  readonly hash: Uint8Array;
}

/** 切片计划。`bytes` 即输入编码后的 UTF-8 字节（同一实例，不复制）。 */
export interface JsonSlicePlan {
  readonly planVersion: 1;
  readonly bytes: Uint8Array;
  /** 未被选中的字节，已合并相邻区间；`literals.length === refs.length + 1`。 */
  readonly literals: readonly SliceRange[];
  /** 被选中的消息元素原文，按原顺序、保留重复。 */
  readonly refs: readonly SliceRef[];
  /** 去重后的内容 hash，按首次出现顺序（供 W5 批量存在性确认）。 */
  readonly hashes: readonly Uint8Array[];
  /** 未压缩 manifest 全长度（74B header + 4B token_count + token 数据），不含 deflate 收益。 */
  readonly manifestBytes: number;
}

/** 扫描结果：`ok` 或明确降级（调用方原样走 codec 0/1）。 */
export type JsonSliceResult =
  | { readonly status: "ok"; readonly plan: JsonSlicePlan }
  | { readonly status: "degrade"; readonly reason: JsonSliceDegradeReason };

/** 扫描期内的降级信号；不会逃出 `planJsonSlices`。 */
class DegradeSignal extends Error {
  readonly reason: JsonSliceDegradeReason;

  constructor(reason: JsonSliceDegradeReason) {
    super(reason);
    this.name = "DegradeSignal";
    this.reason = reason;
  }
}

interface ScanState {
  readonly bytes: Uint8Array;
  readonly limits: JsonSliceLimits;
  pos: number;
  /** messages 数组元素计数（含留在 LITERAL 的小元素）。 */
  elements: number;
  /** 选中的 REF 区间，扁平存放为 `[start, end, start, end, …]`。 */
  refs: number[];
  /** 顶层对象中解码后等于 `messages` 的属性名出现次数。 */
  messagesKeys: number;
  /** 是否找到用于切分的 messages 数组。 */
  messagesArrayFound: boolean;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const MESSAGES_KEY = "messages";

/** JSON 简单转义字节 → 码点，两个扫描器共用：34=`"`，47=`/`，92=`\`，98=`b`，102=`f`，110=`n`，114=`r`，116=`t`。 */
const SIMPLE_ESCAPES: Record<number, number> = {
  34: 34,
  47: 47,
  92: 92,
  98: 8,
  102: 12,
  110: 10,
  114: 13,
  116: 9,
};

/** 0x20 / 0x09 / 0x0a / 0x0d 是 JSON 允许的四种空白字节。 */
function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isHexDigit(byte: number): boolean {
  return isDigit(byte) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

function skipWhitespace(state: ScanState): void {
  const { bytes } = state;
  let pos = state.pos;
  while (pos < bytes.length && isWhitespace(bytes[pos])) pos++;
  state.pos = pos;
}

/** 消费值之后的 `,`（继续）或容器闭合（返回 false）；其他字节都是语法错误。 */
function closeOrContinue(state: ScanState, closeByte: number): boolean {
  skipWhitespace(state);
  const byte = state.bytes[state.pos];
  if (byte === COMMA) {
    state.pos++;
    skipWhitespace(state);
    return true;
  }
  if (byte === closeByte) {
    state.pos++;
    return false;
  }
  throw new DegradeSignal("not-json");
}

/** 扫描一个 JSON 字符串字面量，结束时 `pos` 指向闭合引号之后。 */
function parseString(state: ScanState): void {
  const { bytes } = state;
  let pos = state.pos + 1;
  for (;;) {
    if (pos >= bytes.length) throw new DegradeSignal("not-json");
    const byte = bytes[pos];
    if (byte === QUOTE) {
      state.pos = pos + 1;
      return;
    }
    if (byte === BACKSLASH) {
      pos++;
      if (pos >= bytes.length) throw new DegradeSignal("not-json");
      const escapedByte = bytes[pos];
      if (escapedByte === 0x75) {
        if (pos + 4 >= bytes.length) throw new DegradeSignal("not-json");
        for (let offset = 1; offset <= 4; offset++) {
          if (!isHexDigit(bytes[pos + offset])) throw new DegradeSignal("not-json");
        }
        pos += 5;
        continue;
      }
      if (SIMPLE_ESCAPES[escapedByte] === undefined) throw new DegradeSignal("not-json");
      pos++;
      continue;
    }
    if (byte < 0x20) throw new DegradeSignal("not-json");
    pos++;
  }
}

/** 扫描一个 JSON 数字字面量（只校验语法，不做浮点转换）。 */
function parseNumber(state: ScanState): void {
  const { bytes } = state;
  let pos = state.pos;
  if (bytes[pos] === 0x2d) pos++;
  if (bytes[pos] === 0x30) {
    pos++;
  } else if (isDigit(bytes[pos])) {
    pos++;
    while (isDigit(bytes[pos])) pos++;
  } else {
    throw new DegradeSignal("not-json");
  }
  if (bytes[pos] === 0x2e) {
    pos++;
    if (!isDigit(bytes[pos])) throw new DegradeSignal("not-json");
    while (isDigit(bytes[pos])) pos++;
  }
  if (bytes[pos] === 0x65 || bytes[pos] === 0x45) {
    pos++;
    if (bytes[pos] === 0x2b || bytes[pos] === 0x2d) pos++;
    if (!isDigit(bytes[pos])) throw new DegradeSignal("not-json");
    while (isDigit(bytes[pos])) pos++;
  }
  state.pos = pos;
}

function parseKeyword(state: ScanState, keyword: string): void {
  const { bytes } = state;
  if (state.pos + keyword.length > bytes.length) throw new DegradeSignal("not-json");
  for (let index = 0; index < keyword.length; index++) {
    if (bytes[state.pos + index] !== keyword.charCodeAt(index)) throw new DegradeSignal("not-json");
  }
  state.pos += keyword.length;
}

function parseValue(state: ScanState, depth: number): void {
  const byte = state.bytes[state.pos];
  if (byte === OPEN_BRACE) parseObject(state, depth, false);
  else if (byte === OPEN_BRACKET) parseArray(state, depth);
  else if (byte === QUOTE) parseString(state);
  else if (byte === 0x74) parseKeyword(state, "true");
  else if (byte === 0x66) parseKeyword(state, "false");
  else if (byte === 0x6e) parseKeyword(state, "null");
  else if (byte === 0x2d || isDigit(byte)) parseNumber(state);
  else throw new DegradeSignal("not-json");
}

/** 通用数组：只校验语法，不记录候选。 */
function parseArray(state: ScanState, depth: number): void {
  if (depth > state.limits.maxDepth) throw new DegradeSignal("too-deep");
  const { bytes } = state;
  state.pos++;
  skipWhitespace(state);
  if (bytes[state.pos] === CLOSE_BRACKET) {
    state.pos++;
    return;
  }
  while (true) {
    parseValue(state, depth + 1);
    if (!closeOrContinue(state, CLOSE_BRACKET)) return;
  }
}

/**
 * 对象：校验语法。`trackMessagesKey` 只在顶层为 true —— 按 §4.1 仅该层局部解码属性名，
 * 识别 `"messages"` 与 `"\u006dessages"` 等转义同名；同名出现两次（含转义）整体降级。
 * 其他位置的重复键按 §4.2 保留原字节，不降级。
 */
function parseObject(state: ScanState, depth: number, trackMessagesKey: boolean): void {
  if (depth > state.limits.maxDepth) throw new DegradeSignal("too-deep");
  const { bytes } = state;
  state.pos++;
  skipWhitespace(state);
  if (bytes[state.pos] === CLOSE_BRACE) {
    state.pos++;
    return;
  }
  while (true) {
    if (bytes[state.pos] !== QUOTE) throw new DegradeSignal("not-json");
    const keyStart = state.pos;
    parseString(state);
    const isMessages = trackMessagesKey && isMessagesProperty(bytes, keyStart, state.pos);
    if (isMessages) {
      state.messagesKeys++;
      if (state.messagesKeys > 1) throw new DegradeSignal("duplicate-messages-key");
    }
    skipWhitespace(state);
    if (bytes[state.pos] !== 0x3a) throw new DegradeSignal("not-json");
    state.pos++;
    skipWhitespace(state);
    if (isMessages) {
      if (bytes[state.pos] !== OPEN_BRACKET) throw new DegradeSignal("unsupported-shape");
      state.messagesArrayFound = true;
      parseMessagesArray(state, depth + 1);
    } else {
      parseValue(state, depth + 1);
    }
    if (!closeOrContinue(state, CLOSE_BRACE)) return;
  }
}

/** messages 数组：校验语法并记录元素原文区间与元素数。 */
function parseMessagesArray(state: ScanState, depth: number): void {
  if (depth > state.limits.maxDepth) throw new DegradeSignal("too-deep");
  const { bytes, limits } = state;
  state.pos++;
  skipWhitespace(state);
  if (bytes[state.pos] === CLOSE_BRACKET) {
    state.pos++;
    return;
  }
  while (true) {
    skipWhitespace(state);
    const start = state.pos;
    parseValue(state, depth + 1);
    const end = state.pos;
    state.elements++;
    if (state.elements > limits.maxElements) throw new DegradeSignal("too-many-elements");
    if (end - start >= limits.minElementBytes) state.refs.push(start, end);
    if (!closeOrContinue(state, CLOSE_BRACKET)) return;
  }
}

/**
 * 属性名解码后是否等于 `messages`。只处理 ASCII 目标：多字节 UTF-8 或 > 0x7F 的 `\uXXXX` 直接不等。
 */
function isMessagesProperty(bytes: Uint8Array, start: number, end: number): boolean {
  let matched = 0;
  for (let pos = start + 1; pos < end - 1; pos++) {
    let code = bytes[pos];
    if (code === BACKSLASH) {
      pos++;
      const escapedByte = bytes[pos];
      if (escapedByte === 0x75) {
        code = 0;
        for (let offset = 1; offset <= 4; offset++) {
          const digit = bytes[pos + offset];
          code = code * 16 + (digit <= 0x39 ? digit - 0x30 : (digit & ~0x20) - 0x41 + 10);
        }
        pos += 4;
        if (code > 0x7f) return false;
      } else {
        code = SIMPLE_ESCAPES[escapedByte];
        if (code === undefined) return false;
      }
    } else if (code > 0x7f) {
      return false;
    }
    if (matched >= MESSAGES_KEY.length || code !== MESSAGES_KEY.charCodeAt(matched)) return false;
    matched++;
  }
  return matched === MESSAGES_KEY.length;
}

function scanJson(state: ScanState): void {
  const { bytes } = state;
  skipWhitespace(state);
  const byte = bytes[state.pos];
  if (byte === OPEN_BRACKET) {
    state.messagesArrayFound = true;
    parseMessagesArray(state, 1);
  } else if (byte === OPEN_BRACE) {
    parseObject(state, 1, true);
  } else {
    parseValue(state, 1);
  }
  skipWhitespace(state);
  if (state.pos !== bytes.length) throw new DegradeSignal("not-json");
}

/** §5.1 内容 hash：SHA256(UTF8("peri-fuse:io-message:v1\0") || message_bytes)。 */
function hashMessage(bytes: Uint8Array, start: number, end: number): Buffer {
  return crypto
    .createHash("sha256")
    .update(IO_MESSAGE_HASH_DOMAIN)
    .update(bytes.subarray(start, end))
    .digest();
}

/**
 * 规划 input 的原文切片。
 *
 * - 非法 UTF-16（孤立代理项）抛 `IO_TEXT_INVALID_UTF16`，与既有编码器校验一致，不用降级掩盖；
 *   非 `string` 抛 `IO_CAS_INVALID_INPUT`（调用方编程错误）。
 * - 其余不可切分 / 超预算情况一律返回 `degrade`，调用方原样走 codec 0/1。
 * - 多个降级条件同时成立时以扫描顺序最先触发者为准（`input-too-small` / `input-too-large`
 *   在扫描前判定并优先）；原因字符串只用于观测，不影响存储行为。
 */
export function planJsonSlices(
  input: string,
  overrides: Partial<JsonSliceLimits> = {},
): JsonSliceResult {
  if (typeof input !== "string") throw new Error("IO_CAS_INVALID_INPUT");
  if (/[\uD800-\uDFFF]/u.test(input)) throw new Error("IO_TEXT_INVALID_UTF16");
  const limits: JsonSliceLimits = { ...JSON_SLICE_DEFAULT_LIMITS, ...overrides };
  const inputBytes = Buffer.byteLength(input, "utf8");
  if (inputBytes > limits.maxInputBytes) return { status: "degrade", reason: "input-too-large" };
  if (inputBytes < limits.minInputBytes) return { status: "degrade", reason: "input-too-small" };
  const bytes = Buffer.from(input, "utf8");
  const state: ScanState = {
    bytes,
    limits,
    pos: 0,
    elements: 0,
    refs: [],
    messagesKeys: 0,
    messagesArrayFound: false,
  };
  try {
    scanJson(state);
  } catch (error) {
    if (error instanceof DegradeSignal) return { status: "degrade", reason: error.reason };
    throw error;
  }
  if (!state.messagesArrayFound) return { status: "degrade", reason: "unsupported-shape" };
  if (state.refs.length === 0) return { status: "degrade", reason: "no-candidate" };

  const refCount = state.refs.length / 2;
  let refBytes = 0;
  for (let index = 0; index < state.refs.length; index += 2) {
    refBytes += state.refs[index + 1] - state.refs[index];
  }
  if (refBytes < inputBytes * limits.minRefRatio) {
    return { status: "degrade", reason: "refs-below-ratio" };
  }

  const literals: SliceRange[] = [];
  let cursor = 0;
  for (let index = 0; index < state.refs.length; index += 2) {
    const start = state.refs[index];
    if (start > cursor) literals.push({ start: cursor, end: start });
    cursor = state.refs[index + 1];
  }
  if (cursor < inputBytes) literals.push({ start: cursor, end: inputBytes });

  if (literals.length + refCount > limits.maxTokens) {
    return { status: "degrade", reason: "token-budget-exceeded" };
  }

  // §5.2 未压缩布局：74B header + 4B token_count + LITERAL(1B tag + u32 length + bytes) + REF(1B + 32B)
  let manifestBytes = 74 + 4 + refCount * 33;
  for (const literal of literals) manifestBytes += 5 + (literal.end - literal.start);
  if (manifestBytes > limits.maxManifestBytes) {
    return { status: "degrade", reason: "manifest-too-large" };
  }
  if (limits.requireManifestSmaller && manifestBytes >= inputBytes) {
    return { status: "degrade", reason: "manifest-not-smaller" };
  }

  const refs: SliceRef[] = [];
  const hashes: Uint8Array[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < state.refs.length; index += 2) {
    const start = state.refs[index];
    const end = state.refs[index + 1];
    const hash = hashMessage(bytes, start, end);
    refs.push({ start, end, hash });
    const key = hash.toString("hex");
    if (!seen.has(key)) {
      seen.add(key);
      hashes.push(hash);
    }
  }
  return { status: "ok", plan: { planVersion: 1, bytes, literals, refs, hashes, manifestBytes } };
}
