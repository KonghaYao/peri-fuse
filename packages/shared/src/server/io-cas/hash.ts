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

/** 增量 `original_hash` 计算器（与 W4a `HydrateIoDeps.createOriginalHasher` 同形）。 */
export interface OriginalHasher {
  update(bytes: Uint8Array): void;
  digest(): Uint8Array;
}

/**
 * 与 `node:crypto.createHash("sha256")` 同形的摘要器。
 *
 * 只声明本模块实际使用的方法，`digest()` 刻意只用 `Uint8Array`：
 * worker 侧由依赖表达式注入 `require("node:crypto").createHash`，返回值在两侧都是 Buffer。
 */
export interface HashHasher {
  update(bytes: Uint8Array): HashHasher;
  update(text: string, encoding: "utf8"): HashHasher;
  digest(): Uint8Array;
}

/**
 * hash 运行时的显式依赖（**冻结契约**，W4b 的 reader source 依赖它）。
 *
 * 域前缀与 hash 长度全部注入而不是从模块作用域读取：`makeHashRuntime` 的函数体会被
 * `toString()` 后注入 worker（D-5 内联路线），引用任何模块级符号都会变成 ReferenceError。
 */
export interface HashRuntimeDeps {
  createHash(algorithm: "sha256"): HashHasher;
  contentDomain: string;
  originalDomain: string;
  bodyDomain: string;
  hashBytes: number;
}

export interface HashRuntime {
  contentHash(messageBytes: Uint8Array): Buffer;
  originalHash(inputBytes: Uint8Array): Buffer;
  bodyHash(bodyBytes: Uint8Array): Buffer;
  hashToHex(hash: Uint8Array): string;
  equalBytes(left: Uint8Array, right: Uint8Array): boolean;
  createOriginalHasher(): OriginalHasher;
}

/**
 * 构造 hash 运行时（纯逻辑实例，依赖显式注入）。
 *
 * 返回值与模块级导出的 `contentHash` / `originalHash` / `bodyHash` / `hashToHex` /
 * `equalBytes` 行为逐字节一致；仅作用域来源不同（`deps` 而非模块常量）。
 */
export function makeHashRuntime(deps: HashRuntimeDeps): HashRuntime {
  /** 零拷贝 Buffer 视图：只覆盖视图自身的 byteOffset/byteLength。 */
  function asView(bytes: Uint8Array): Buffer {
    return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  }

  function digest(domain: string, bytes: Uint8Array): Buffer {
    // `update(Uint8Array)` 遵循 byteOffset/byteLength，因此 subarray 视图无需拷贝。
    const view = deps.createHash("sha256").update(domain, "utf8").update(bytes).digest();
    return asView(view);
  }

  /** 池内容键：`SHA256(UTF8("peri-fuse:io-message:v1\0") || message_bytes)`。 */
  function contentHash(messageBytes: Uint8Array): Buffer {
    return digest(deps.contentDomain, messageBytes);
  }

  /** 完整 input 原文校验：`SHA256(UTF8("peri-fuse:io-input:v1\0") + input_bytes)`。 */
  function originalHash(inputBytes: Uint8Array): Buffer {
    return digest(deps.originalDomain, inputBytes);
  }

  /** 未压缩 manifest body 校验：`SHA256(UTF8("peri-fuse:io-manifest:v1\0") + body_bytes)`。 */
  function bodyHash(bodyBytes: Uint8Array): Buffer {
    return digest(deps.bodyDomain, bodyBytes);
  }

  /**
   * 把 32 字节 hash 转成小写十六进制（64 字符）。
   *
   * 这是 `assembleInput(chunksByHex)` 与批量查表使用的规范键格式；
   * 非 `hashBytes` 字节输入属于编程错误，直接报 `IO_CAS_INVALID`，不做静默截断。
   */
  function hashToHex(hash: Uint8Array): string {
    if (!(hash instanceof Uint8Array) || hash.byteLength !== deps.hashBytes)
      throw new Error("IO_CAS_INVALID");
    return Buffer.from(hash).toString("hex");
  }

  /** 逐字节比较；长度不同直接返回 false。用于 hash 与池内原文的严格比对。 */
  function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    if (left === right) return true;
    return Buffer.compare(asView(left), asView(right)) === 0;
  }

  /** 新建增量 `original_hash` 计算器；域必须是 `peri-fuse:io-input:v1\0`。 */
  function createOriginalHasher(): OriginalHasher {
    const hasher = deps.createHash("sha256").update(deps.originalDomain, "utf8");
    return {
      update: (bytes: Uint8Array) => {
        hasher.update(bytes);
      },
      digest: () => hasher.digest(),
    };
  }

  return { contentHash, originalHash, bodyHash, hashToHex, equalBytes, createOriginalHasher };
}

const HASH_RUNTIME = makeHashRuntime({
  createHash: (algorithm) => createHash(algorithm),
  contentDomain: CONTENT_HASH_DOMAIN,
  originalDomain: ORIGINAL_HASH_DOMAIN,
  bodyDomain: BODY_HASH_DOMAIN,
  hashBytes: HASH_BYTES,
});

export const contentHash = HASH_RUNTIME.contentHash;
export const originalHash = HASH_RUNTIME.originalHash;
export const bodyHash = HASH_RUNTIME.bodyHash;
export const hashToHex = HASH_RUNTIME.hashToHex;
export const equalBytes = HASH_RUNTIME.equalBytes;
