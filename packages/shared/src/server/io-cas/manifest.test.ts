import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { CAS_MAX_BYTES, CHUNK_CODEC_DEFLATE, CHUNK_CODEC_RAW } from "./chunk-codec";
import { bodyHash, contentHash, hashToHex, originalHash } from "./hash";
import {
  assembleInput,
  collectRefHashes,
  encodeManifest,
  MANIFEST_HEADER_BYTES,
  MANIFEST_MAX_TOKENS,
  type ManifestToken,
  parseManifest,
} from "./manifest";

const MESSAGE_ONE = '{"role":"user","content":"你好🌍"}';
const MESSAGE_TWO = '  {  "role" : "assistant",  "content" : "ok\\n"  }  ';
const HEAD = '  {\n\t"messages": [';
const MIDDLE = ",\r\n ";
const TAIL = "]\n}\n";
const ORIGINAL = `${HEAD}${MESSAGE_ONE}${MIDDLE}${MESSAGE_TWO}${TAIL}`;
const ORIGINAL_BYTES = Buffer.from(ORIGINAL, "utf8");
const MESSAGE_ONE_BYTES = Buffer.from(MESSAGE_ONE, "utf8");
const MESSAGE_TWO_BYTES = Buffer.from(MESSAGE_TWO, "utf8");
const HUGE = Buffer.alloc(CAS_MAX_BYTES + 1, 0x61);

function tokens(): ManifestToken[] {
  return [
    { tag: "literal", bytes: Buffer.from(HEAD, "utf8") },
    { tag: "ref", hash: contentHash(MESSAGE_ONE_BYTES) },
    { tag: "literal", bytes: Buffer.from(MIDDLE, "utf8") },
    { tag: "ref", hash: contentHash(MESSAGE_TWO_BYTES) },
    { tag: "literal", bytes: Buffer.from(TAIL, "utf8") },
  ];
}

/** 池内已解码内容的规范键图：hex(content_hash) → 原文。 */
function chunkMap(): Map<string, Uint8Array> {
  return new Map([
    [hashToHex(contentHash(MESSAGE_ONE_BYTES)), MESSAGE_ONE_BYTES],
    [hashToHex(contentHash(MESSAGE_TWO_BYTES)), MESSAGE_TWO_BYTES],
  ]);
}

function literalToken(bytes: Uint8Array): Buffer {
  const token = Buffer.allocUnsafe(5 + bytes.byteLength);
  token.writeUInt8(0, 0);
  token.writeUInt32LE(bytes.byteLength, 1);
  token.set(bytes, 5);
  return token;
}

function refToken(hash: Uint8Array): Buffer {
  const token = Buffer.allocUnsafe(1 + hash.byteLength);
  token.writeUInt8(1, 0);
  token.set(hash, 1);
  return token;
}

function bodyOf(parts: Uint8Array[], declaredCount = parts.length): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(declaredCount, 0);
  return Buffer.concat([head, ...parts]);
}

/** 按设计 §5.2 的字节表手工拼装 manifest，用于构造损坏样本。 */
function rawManifest(options: {
  magic?: string;
  version?: number;
  bodyCodec?: number;
  bodyRawSize?: number;
  originalHash?: Uint8Array;
  bodyHash?: Uint8Array;
  body?: Uint8Array;
}): Buffer {
  const body = options.body ?? Buffer.alloc(0);
  const header = Buffer.alloc(MANIFEST_HEADER_BYTES);
  header.write(options.magic ?? "PFIC", 0, "ascii");
  header.writeUInt8(options.version ?? 1, 4);
  header.writeUInt8(options.bodyCodec ?? CHUNK_CODEC_RAW, 5);
  header.writeUInt32LE(options.bodyRawSize ?? body.byteLength, 6);
  header.set(options.originalHash ?? originalHash(ORIGINAL_BYTES), 10);
  header.set(options.bodyHash ?? bodyHash(body), 42);
  return Buffer.concat([header, body]);
}

it("writes the frozen 74-byte header layout and the token stream byte table", () => {
  const plan = tokens();
  const manifest = encodeManifest(plan, ORIGINAL_BYTES, { compress: false });
  const body = manifest.subarray(MANIFEST_HEADER_BYTES);
  expect(manifest.subarray(0, 4).toString("latin1")).toBe("PFIC");
  expect(manifest.readUInt8(4)).toBe(1);
  expect(manifest.readUInt8(5)).toBe(CHUNK_CODEC_RAW);
  expect(manifest.readUInt32LE(6)).toBe(body.byteLength);
  expect(manifest.subarray(10, 42)).toEqual(originalHash(ORIGINAL_BYTES));
  expect(manifest.subarray(42, 74)).toEqual(bodyHash(body));
  expect(body.readUInt32LE(0)).toBe(plan.length);
  let offset = 4;
  for (const token of plan) {
    if (token.tag === "literal") {
      expect(body.readUInt8(offset)).toBe(0);
      expect(body.readUInt32LE(offset + 1)).toBe(token.bytes.byteLength);
      expect(body.subarray(offset + 5, offset + 5 + token.bytes.byteLength)).toEqual(
        Buffer.from(token.bytes),
      );
      offset += 5 + token.bytes.byteLength;
    } else {
      expect(body.readUInt8(offset)).toBe(1);
      expect(body.subarray(offset + 1, offset + 33)).toEqual(Buffer.from(token.hash));
      offset += 33;
    }
  }
  expect(offset).toBe(body.byteLength);
});

it("round-trips literal and reference tokens back to the exact original text", () => {
  const manifest = parseManifest(encodeManifest(tokens(), ORIGINAL_BYTES));
  expect(manifest.version).toBe(1);
  expect(manifest.tokenCount).toBe(5);
  expect(manifest.refCount).toBe(2);
  expect(manifest.literalBytes).toBe(Buffer.byteLength(HEAD + MIDDLE + TAIL, "utf8"));
  expect(manifest.bodyRawSize).toBeGreaterThan(0);
  expect(assembleInput(manifest, chunkMap(), ORIGINAL_BYTES.byteLength)).toBe(ORIGINAL);
  expect(
    Buffer.from(assembleInput(manifest, chunkMap(), ORIGINAL_BYTES.byteLength), "utf8"),
  ).toEqual(ORIGINAL_BYTES);
});

it("compresses the body only when profitable, and honours an explicit choice", () => {
  const compressible: ManifestToken[] = [{ tag: "literal", bytes: Buffer.alloc(4096, 0x61) }];
  const automatically = parseManifest(encodeManifest(compressible, Buffer.from("original")));
  expect(automatically.bodyCodec).toBe(CHUNK_CODEC_DEFLATE);
  expect(automatically.bodyRawSize).toBe(4 + 5 + 4096);
  const raw = parseManifest(
    encodeManifest(compressible, Buffer.from("original"), { compress: false }),
  );
  expect(raw.bodyCodec).toBe(CHUNK_CODEC_RAW);
  expect(raw.bodyRawSize).toBe(4 + 5 + 4096);
  const tiny: ManifestToken[] = [{ tag: "literal", bytes: Buffer.from("a") }];
  expect(parseManifest(encodeManifest(tiny, Buffer.from("a"))).bodyCodec).toBe(CHUNK_CODEC_RAW);
  const forced = parseManifest(encodeManifest(tiny, Buffer.from("a"), { compress: true }));
  expect(forced.bodyCodec).toBe(CHUNK_CODEC_DEFLATE);
  expect(assembleInput(forced, new Map(), Buffer.byteLength("a"))).toBe("a");
});

it("accepts an empty token stream only when the declared raw size is also zero", () => {
  const manifest = parseManifest(encodeManifest([], Buffer.alloc(0), { compress: false }));
  expect(manifest.tokenCount).toBe(0);
  expect(manifest.tokens).toEqual([]);
  expect(assembleInput(manifest, new Map(), 0)).toBe("");
  expect(() => assembleInput(manifest, new Map(), 1)).toThrow("IO_CAS_CORRUPT");
});

it("accepts a typed-array view whose byteOffset is not zero", () => {
  const manifest = encodeManifest(tokens(), ORIGINAL_BYTES, { compress: false });
  const padded = Buffer.concat([Buffer.from([1, 2, 3]), manifest, Buffer.from([4])]);
  const view = padded.subarray(3, 3 + manifest.byteLength);
  expect(view.buffer).toBe(padded.buffer);
  expect(view.byteOffset).toBe(padded.byteOffset + 3);
  expect(view.byteOffset).toBeGreaterThan(0);
  const parsed = parseManifest(view);
  expect(assembleInput(parsed, chunkMap(), ORIGINAL_BYTES.byteLength)).toBe(ORIGINAL);
});

it("rejects unknown magic, version and body codec as version errors", () => {
  const body = bodyOf([literalToken(Buffer.from("body"))]);
  expect(() => parseManifest(rawManifest({ body, magic: "PFIX" }))).toThrow("IO_CAS_VERSION");
  expect(() => parseManifest(rawManifest({ body, version: 2 }))).toThrow("IO_CAS_VERSION");
  expect(() => parseManifest(rawManifest({ body, bodyCodec: 2 }))).toThrow("IO_CAS_VERSION");
  expect(() => parseManifest(rawManifest({ body, bodyCodec: 9 }))).toThrow("IO_CAS_VERSION");
});

it("rejects short, oversized and mistyped buffers", () => {
  expect(() => parseManifest(Buffer.alloc(0))).toThrow("IO_CAS_INVALID");
  expect(() => parseManifest(Buffer.alloc(MANIFEST_HEADER_BYTES - 1))).toThrow("IO_CAS_INVALID");
  expect(() => parseManifest(Buffer.alloc(MANIFEST_HEADER_BYTES + 3))).toThrow("IO_CAS_INVALID");
  expect(() => parseManifest(HUGE)).toThrow("IO_CAS_LIMIT");
  expect(() => parseManifest("text" as unknown as Uint8Array)).toThrow("IO_CAS_INVALID");
  expect(() => parseManifest(null as unknown as Uint8Array)).toThrow("IO_CAS_INVALID");
  expect(() => parseManifest(new ArrayBuffer(200) as unknown as Uint8Array)).toThrow(
    "IO_CAS_INVALID",
  );
  const plain = new Uint8Array(encodeManifest(tokens(), ORIGINAL_BYTES));
  expect(assembleInput(parseManifest(plain), chunkMap(), ORIGINAL_BYTES.byteLength)).toBe(ORIGINAL);
});

it("rejects body lengths that contradict body_raw_size or leave trailing bytes", () => {
  const body = bodyOf([literalToken(Buffer.from("hello"))]);
  expect(() => parseManifest(rawManifest({ body, bodyRawSize: body.byteLength + 1 }))).toThrow(
    "IO_CAS_CORRUPT",
  );
  expect(() => parseManifest(rawManifest({ body, bodyRawSize: body.byteLength - 1 }))).toThrow(
    "IO_CAS_CORRUPT",
  );
  expect(() => parseManifest(rawManifest({ body, bodyRawSize: CAS_MAX_BYTES + 1 }))).toThrow(
    "IO_CAS_LIMIT",
  );
  const padded = Buffer.concat([rawManifest({ body }), Buffer.from([0])]);
  expect(() => parseManifest(padded)).toThrow("IO_CAS_CORRUPT");
  for (const bodyRawSize of [0, 1, 3]) {
    expect(() => parseManifest(rawManifest({ body: Buffer.alloc(bodyRawSize) }))).toThrow(
      "IO_CAS_INVALID",
    );
  }
});

it("rejects tampered body bytes through body_hash", () => {
  const manifest = encodeManifest(tokens(), ORIGINAL_BYTES, { compress: false });
  const tampered = Buffer.from(manifest);
  const bodyStart = MANIFEST_HEADER_BYTES + 4 + 5;
  tampered[bodyStart] ^= 0x20;
  expect(() => parseManifest(tampered)).toThrow("IO_CAS_CORRUPT");
  const swappedHash = Buffer.from(manifest);
  swappedHash[42] ^= 0xff;
  expect(() => parseManifest(swappedHash)).toThrow("IO_CAS_CORRUPT");
  const swappedOriginal = Buffer.from(manifest);
  swappedOriginal[10] ^= 0xff;
  const parsed = parseManifest(swappedOriginal);
  expect(() => assembleInput(parsed, chunkMap(), ORIGINAL_BYTES.byteLength)).toThrow(
    "IO_CAS_CORRUPT",
  );
});

it("rejects corrupted compressed bodies and unknown compressed streams", () => {
  const body = bodyOf([literalToken(Buffer.alloc(4096, 0x62))]);
  const compressed = deflateSync(body);
  const intact = rawManifest({
    body: compressed,
    bodyCodec: CHUNK_CODEC_DEFLATE,
    bodyRawSize: body.byteLength,
    bodyHash: bodyHash(body),
  });
  expect(parseManifest(intact).tokenCount).toBe(1);
  expect(() => parseManifest(intact.subarray(0, intact.byteLength - 4))).toThrow("IO_CAS_CORRUPT");
  expect(() => parseManifest(Buffer.concat([intact, Buffer.from([0, 0, 0])]))).toThrow(
    "IO_CAS_CORRUPT",
  );
  expect(() =>
    parseManifest(
      rawManifest({
        body: Buffer.from("not-deflate"),
        bodyCodec: CHUNK_CODEC_DEFLATE,
        bodyRawSize: 11,
        bodyHash: bodyHash(Buffer.from("not-deflate")),
      }),
    ),
  ).toThrow("IO_CAS_CORRUPT");
});

it("rejects malformed token streams that a matching body_hash would otherwise bless", () => {
  const badTag = bodyOf([Buffer.from([2, 0, 0, 0, 0])]);
  expect(() => parseManifest(rawManifest({ body: badTag }))).toThrow("IO_CAS_INVALID");
  const truncatedLiteral = bodyOf([Buffer.from([0, 9, 0, 0, 0, 0x61])]);
  expect(() => parseManifest(rawManifest({ body: truncatedLiteral }))).toThrow("IO_CAS_INVALID");
  const truncatedRef = bodyOf([Buffer.from([1, 0, 0])]);
  expect(() => parseManifest(rawManifest({ body: truncatedRef }))).toThrow("IO_CAS_INVALID");
  const shortHash = bodyOf([refToken(Buffer.alloc(31, 7))]);
  expect(() => parseManifest(rawManifest({ body: shortHash }))).toThrow("IO_CAS_INVALID");
  const declaredTooMany = bodyOf([literalToken(Buffer.from("x"))], 2);
  expect(() => parseManifest(rawManifest({ body: declaredTooMany }))).toThrow("IO_CAS_INVALID");
  const declaredTooFew = bodyOf([literalToken(Buffer.from("x"))], 0);
  expect(() => parseManifest(rawManifest({ body: declaredTooFew }))).toThrow("IO_CAS_INVALID");
  const literalLengthOverrun = bodyOf([Buffer.from([0, 0xff, 0xff, 0xff, 0xff, 0x61])]);
  expect(() => parseManifest(rawManifest({ body: literalLengthOverrun }))).toThrow(
    "IO_CAS_INVALID",
  );
});

it("enforces the 20,001 token ceiling on both encode and parse", () => {
  const hash = contentHash(MESSAGE_ONE_BYTES);
  const atLimit: ManifestToken[] = Array.from({ length: MANIFEST_MAX_TOKENS }, () => ({
    tag: "ref" as const,
    hash,
  }));
  const manifest = parseManifest(encodeManifest(atLimit, ORIGINAL_BYTES, { compress: false }));
  expect(manifest.tokenCount).toBe(MANIFEST_MAX_TOKENS);
  expect(manifest.refCount).toBe(MANIFEST_MAX_TOKENS);
  expect(collectRefHashes(manifest)).toHaveLength(1);
  expect(() => encodeManifest([...atLimit, atLimit[0]], ORIGINAL_BYTES)).toThrow("IO_CAS_LIMIT");
  const declared = Buffer.alloc(4);
  declared.writeUInt32LE(MANIFEST_MAX_TOKENS + 1, 0);
  expect(() => parseManifest(rawManifest({ body: declared }))).toThrow("IO_CAS_LIMIT");
});

it("rejects a missing chunk instead of returning a partial input", () => {
  const manifest = parseManifest(encodeManifest(tokens(), ORIGINAL_BYTES));
  const partial = chunkMap();
  partial.delete(hashToHex(contentHash(MESSAGE_TWO_BYTES)));
  expect(() => assembleInput(manifest, partial, ORIGINAL_BYTES.byteLength)).toThrow(
    "IO_CAS_MISSING",
  );
  expect(() => assembleInput(manifest, new Map(), ORIGINAL_BYTES.byteLength)).toThrow(
    "IO_CAS_MISSING",
  );
});

it("rejects silently substituted chunk content and non-binary map values", () => {
  const manifest = parseManifest(encodeManifest(tokens(), ORIGINAL_BYTES));
  const substituted = chunkMap();
  substituted.set(
    hashToHex(contentHash(MESSAGE_ONE_BYTES)),
    Buffer.from(MESSAGE_ONE.replace("user", "root"), "utf8"),
  );
  expect(() => assembleInput(manifest, substituted, ORIGINAL_BYTES.byteLength)).toThrow(
    "IO_CAS_CORRUPT",
  );
  const wrongLength = chunkMap();
  wrongLength.set(hashToHex(contentHash(MESSAGE_ONE_BYTES)), Buffer.from("short"));
  expect(() => assembleInput(manifest, wrongLength, ORIGINAL_BYTES.byteLength)).toThrow(
    "IO_CAS_CORRUPT",
  );
  const nonBinary = chunkMap();
  nonBinary.set(hashToHex(contentHash(MESSAGE_ONE_BYTES)), MESSAGE_ONE as unknown as Uint8Array);
  expect(() => assembleInput(manifest, nonBinary, ORIGINAL_BYTES.byteLength)).toThrow(
    "IO_CAS_INVALID",
  );
});

it("rejects a reassembled length that differs from input_raw_size", () => {
  const manifest = parseManifest(encodeManifest(tokens(), ORIGINAL_BYTES));
  const exact = ORIGINAL_BYTES.byteLength;
  for (const declared of [exact - 1, exact + 1, 0]) {
    expect(() => assembleInput(manifest, chunkMap(), declared)).toThrow("IO_CAS_CORRUPT");
  }
  expect(() => assembleInput(manifest, chunkMap(), CAS_MAX_BYTES + 1)).toThrow("IO_CAS_LIMIT");
  for (const declared of [-1, 1.5, Number.NaN]) {
    expect(() => assembleInput(manifest, chunkMap(), declared)).toThrow("IO_CAS_INVALID");
  }
});

it("rejects reassembled bytes that are not round-trippable UTF-8", () => {
  const invalid = Buffer.from([0x80, 0xff, 0xfe]);
  const body = bodyOf([literalToken(invalid)]);
  const manifest = parseManifest(rawManifest({ body, originalHash: originalHash(invalid) }));
  expect(() => assembleInput(manifest, new Map(), invalid.byteLength)).toThrow("IO_CAS_CORRUPT");
  const valid = Buffer.from("你好", "utf8");
  const ok = parseManifest(
    rawManifest({ body: bodyOf([literalToken(valid)]), originalHash: originalHash(valid) }),
  );
  expect(assembleInput(ok, new Map(), valid.byteLength)).toBe("你好");
});

it("collects unique reference hashes in first-appearance order", () => {
  const repeated: ManifestToken[] = [
    { tag: "literal", bytes: Buffer.from(HEAD, "utf8") },
    { tag: "ref", hash: contentHash(MESSAGE_ONE_BYTES) },
    { tag: "ref", hash: contentHash(MESSAGE_TWO_BYTES) },
    { tag: "ref", hash: contentHash(MESSAGE_ONE_BYTES) },
  ];
  const manifest = parseManifest(encodeManifest(repeated, ORIGINAL_BYTES));
  const keys = collectRefHashes(manifest);
  expect(keys.map((key) => key.hex)).toEqual([
    hashToHex(contentHash(MESSAGE_ONE_BYTES)),
    hashToHex(contentHash(MESSAGE_TWO_BYTES)),
  ]);
  for (const key of keys) {
    expect(key.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(key.hash.byteLength).toBe(32);
  }
  expect(collectRefHashes(parseManifest(encodeManifest([], Buffer.alloc(0))))).toEqual([]);
});

it("rejects malformed encode-side tokens, oversized bodies and oversized inputs", () => {
  const invalidTokens = [
    { tag: "literal" },
    { tag: "literal", bytes: "text" },
    { tag: "ref", hash: Buffer.alloc(31) },
    { tag: "ref", hash: Buffer.alloc(33) },
    { tag: "ref" },
    { tag: "other", bytes: Buffer.from("x") },
    null,
    undefined,
  ] as unknown as ManifestToken[];
  for (const token of invalidTokens) {
    expect(() => encodeManifest([token], ORIGINAL_BYTES)).toThrow("IO_CAS_INVALID");
  }
  expect(() => encodeManifest("tokens" as unknown as ManifestToken[], ORIGINAL_BYTES)).toThrow(
    "IO_CAS_INVALID",
  );
  expect(() => encodeManifest(tokens(), "text" as unknown as Uint8Array)).toThrow("IO_CAS_INVALID");
  expect(() => encodeManifest([{ tag: "literal", bytes: HUGE }], ORIGINAL_BYTES)).toThrow(
    "IO_CAS_LIMIT",
  );
  expect(() => encodeManifest(tokens(), HUGE)).toThrow("IO_CAS_LIMIT");
});

it("keeps original_hash and reassembly stable across different token splits", () => {
  const split: ManifestToken[] = [
    { tag: "literal", bytes: Buffer.from(HEAD.slice(0, 2), "utf8") },
    { tag: "literal", bytes: Buffer.from(HEAD.slice(2), "utf8") },
    { tag: "ref", hash: contentHash(MESSAGE_ONE_BYTES) },
    { tag: "literal", bytes: Buffer.from(MIDDLE + MESSAGE_TWO + TAIL, "utf8") },
  ];
  const manifestA = parseManifest(encodeManifest(tokens(), ORIGINAL_BYTES));
  const manifestB = parseManifest(encodeManifest(split, ORIGINAL_BYTES));
  expect(manifestA.originalHash).toEqual(manifestB.originalHash);
  expect(assembleInput(manifestB, chunkMap(), ORIGINAL_BYTES.byteLength)).toBe(ORIGINAL);
  expect(manifestB.literalBytes + MESSAGE_ONE_BYTES.byteLength).toBe(ORIGINAL_BYTES.byteLength);
});
