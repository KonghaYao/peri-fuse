import { inflateSync } from "node:zlib";

/**
 * CAS 单块内容与 manifest body 的字节上限，与 `IO_MAX_BYTES` 同值（32MiB）。
 *
 * 本模块刻意不从 `adapters/io-compression` 导入常量：格式层要能被
 * 读 worker 源码工厂独立内联，不应依赖适配器模块（设计 §7.1）。
 */
export const CAS_MAX_BYTES = 32 * 1024 * 1024;

/** 池内 codec 语义：0 = 明文 BLOB，1 = zlib-wrapped deflate。 */
export const CHUNK_CODEC_RAW = 0;
export const CHUNK_CODEC_DEFLATE = 1;

export interface ChunkSource {
  /** `io_cas_chunks.codec` 或 manifest header 的 `body_codec`。 */
  codec: number;
  /** 原始（解压后）字节长度：`raw_size` / `body_raw_size`。 */
  rawSize: number;
  /** 存储字节：codec 0 即原文，codec 1 为 zlib-wrapped deflate 流。 */
  payload: Uint8Array;
}

/**
 * chunk 解码的显式依赖（**冻结契约**，W4b 的 reader source 依赖它）。
 *
 * `inflate` 与三个常量全部注入：`makeChunkCodecRuntime` 的函数体会被 `toString()` 后
 * 注入 worker（D-5 内联路线），函数体内不得引用模块级符号。
 * `inflate` 的签名与 `node:zlib.inflateSync`（含 `info: true`）一致。
 */
export interface ChunkCodecDeps {
  inflate(
    payload: Uint8Array,
    options: { maxOutputLength: number; info: true },
  ): { buffer: Uint8Array; engine: { bytesWritten: number } };
  rawCodec: number;
  deflateCodec: number;
  maxBytes: number;
}

export interface ChunkCodecRuntime {
  decodeChunk(chunk: ChunkSource): Uint8Array;
}

/**
 * 构造 chunk 解码运行时（纯逻辑实例，依赖显式注入）。
 *
 * 有界解码单块内容（设计 §7.1），三重校验，任一不满足即报错，绝不返回半截或空结果：
 * 1. `maxOutputLength=rawSize` 限制解压输出（防解压炸弹）；
 * 2. 实际输出长度必须等于声明的 `rawSize`；
 * 3. 压缩输入必须被完整消费（尾随/截断字节都会被拒绝）。
 *
 * 错误码：codec 非 0/1 → `IO_CAS_VERSION`；参数类型或 `rawSize` 非安全整数
 * → `IO_CAS_INVALID`；`rawSize > maxBytes` → `IO_CAS_LIMIT`；
 * 长度不符、inflate 失败、输入未消费完 → `IO_CAS_CORRUPT`。
 *
 * codec 0 时返回 `payload` 的只读视图（零拷贝），调用方不得修改。
 * 模块级导出的 `decodeChunk` 由同一工厂构造，行为一致。
 */
export function makeChunkCodecRuntime(deps: ChunkCodecDeps): ChunkCodecRuntime {
  function decodeChunk(chunk: ChunkSource): Uint8Array {
    if (!chunk || !(chunk.payload instanceof Uint8Array)) throw new Error("IO_CAS_INVALID");
    const { codec, payload } = chunk;
    const rawSize = Number(chunk.rawSize);
    if (!Number.isSafeInteger(rawSize) || rawSize < 0) throw new Error("IO_CAS_INVALID");
    if (rawSize > deps.maxBytes) throw new Error("IO_CAS_LIMIT");
    if (codec === deps.rawCodec) {
      if (payload.byteLength !== rawSize) throw new Error("IO_CAS_CORRUPT");
      return payload;
    }
    if (codec !== deps.deflateCodec) throw new Error("IO_CAS_VERSION");
    let result: { buffer: Uint8Array; engine: { bytesWritten: number } };
    try {
      result = deps.inflate(payload, {
        maxOutputLength: Math.max(1, rawSize),
        info: true,
      });
    } catch {
      throw new Error("IO_CAS_CORRUPT");
    }
    if (result.buffer.length !== rawSize || result.engine.bytesWritten !== payload.byteLength)
      throw new Error("IO_CAS_CORRUPT");
    return result.buffer;
  }

  return { decodeChunk };
}

const CHUNK_CODEC_RUNTIME = makeChunkCodecRuntime({
  // `info: true` 让 zlib 返回 `{ buffer, engine }` 而不是单个 Buffer；只在此收敛类型。
  inflate: (payload, options) =>
    inflateSync(payload, options) as unknown as {
      buffer: Uint8Array;
      engine: { bytesWritten: number };
    },
  rawCodec: CHUNK_CODEC_RAW,
  deflateCodec: CHUNK_CODEC_DEFLATE,
  maxBytes: CAS_MAX_BYTES,
});

export const decodeChunk = CHUNK_CODEC_RUNTIME.decodeChunk;
