import { createHash } from "node:crypto";

/**
 * CAS 三个 SHA-256 的域分隔前缀（设计 §5.1 / §5.2）。
 *
 * 前缀是**已发布数据的格式语义**，必须逐字节保持不变：
 * 修改任何前缀都会让历史 manifest 与池内容校验全部失败。
 * 末尾的 `\0` 是分隔符，防止前缀与内容在拼接处产生歧义。
 */
export const CONTENT_HASH_DOMAIN = "peri-fuse:io-message:v1\0";
export const ORIGINAL_HASH_DOMAIN = "peri-fuse:io-input:v1\0";
export const BODY_HASH_DOMAIN = "peri-fuse:io-manifest:v1\0";

/** 所有 CAS hash 固定 32 字节（BLOB 长度为 CHECK 约束的一部分）。 */
export const HASH_BYTES = 32;

function digest(domain: string, bytes: Uint8Array): Buffer {
  // `update(Uint8Array)` 遵循 byteOffset/byteLength，因此 subarray 视图无需拷贝。
  return createHash("sha256").update(domain, "utf8").update(bytes).digest();
}

/** 池内容键：`SHA256(UTF8("peri-fuse:io-message:v1\0") || message_bytes)`。 */
export function contentHash(messageBytes: Uint8Array): Buffer {
  return digest(CONTENT_HASH_DOMAIN, messageBytes);
}

/** 完整 input 原文校验：`SHA256(UTF8("peri-fuse:io-input:v1\0") + input_bytes)`。 */
export function originalHash(inputBytes: Uint8Array): Buffer {
  return digest(ORIGINAL_HASH_DOMAIN, inputBytes);
}

/** 未压缩 manifest body 校验：`SHA256(UTF8("peri-fuse:io-manifest:v1\0") + body_bytes)`。 */
export function bodyHash(bodyBytes: Uint8Array): Buffer {
  return digest(BODY_HASH_DOMAIN, bodyBytes);
}

/**
 * 把 32 字节 hash 转成小写十六进制（64 字符）。
 *
 * 这是 `assembleInput(chunksByHex)` 与批量查表使用的规范键格式；
 * 非 32 字节输入属于编程错误，直接报 `IO_CAS_INVALID`，不做静默截断。
 */
export function hashToHex(hash: Uint8Array): string {
  if (!(hash instanceof Uint8Array) || hash.byteLength !== HASH_BYTES)
    throw new Error("IO_CAS_INVALID");
  return Buffer.from(hash).toString("hex");
}

/** 逐字节比较；长度不同直接返回 false。用于 hash 与池内原文的严格比对。 */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  if (left === right) return true;
  return Buffer.compare(asBufferView(left), asBufferView(right)) === 0;
}

/** 零拷贝只读视图，避免大 payload 比较时产生整段副本。 */
function asBufferView(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}
