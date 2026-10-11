import { expect, it } from "vitest";
import {
  BODY_HASH_DOMAIN,
  bodyHash,
  CONTENT_HASH_DOMAIN,
  contentHash,
  equalBytes,
  HASH_BYTES,
  hashToHex,
  ORIGINAL_HASH_DOMAIN,
  originalHash,
} from "./hash";

const MESSAGE = '{"role":"user","content":"你好🌍"}';
const INPUT = `  {"messages": [${MESSAGE}]}`;
const BODY = Buffer.from([2, 0, 0, 0, 0, 5, 0, 0, 0, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);

/**
 * 期望值由独立实现（Python3 hashlib）按设计 §5.1/§5.2 的前缀计算，
 * 用于钉死三个域字符串的逐字节取值。
 */
it("pins the three domain-separated digests against an independent implementation", () => {
  expect(contentHash(Buffer.from(MESSAGE, "utf8")).toString("hex")).toBe(
    "a470bfcb99b79aaf5128df76fb13f3c18427a1dea5ea61b6afd30333b90e46c7",
  );
  expect(originalHash(Buffer.from(INPUT, "utf8")).toString("hex")).toBe(
    "b1c9eeda0cd85adbd349dd4baccafc068e3a82072e8baed230c3569144a8408d",
  );
  expect(bodyHash(BODY).toString("hex")).toBe(
    "980909e45a0ce2c799fcc1ebd7986a0e6d46409738e8c9b13f25f0365a1df6ad",
  );
  expect(contentHash(Buffer.alloc(0)).toString("hex")).toBe(
    "38bc961aeb127f0f5f39931f295ae0f6a7f43264869a448336f9462c2c96509e",
  );
});

it("keeps the domain prefixes distinct and NUL-terminated", () => {
  expect(CONTENT_HASH_DOMAIN).toBe("peri-fuse:io-message:v1\0");
  expect(ORIGINAL_HASH_DOMAIN).toBe("peri-fuse:io-input:v1\0");
  expect(BODY_HASH_DOMAIN).toBe("peri-fuse:io-manifest:v1\0");
  const bytes = Buffer.from("same-bytes", "utf8");
  const digests = [contentHash, originalHash, bodyHash].map((hash) => hash(bytes));
  expect(new Set(digests.map((digest) => digest.toString("hex"))).size).toBe(3);
  for (const digest of digests) {
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.byteLength).toBe(HASH_BYTES);
  }
});

it("hashes exactly the bytes a typed-array view covers (byteOffset aware)", () => {
  const payload = Buffer.from(MESSAGE, "utf8");
  const padded = Buffer.concat([Buffer.from("xxxx"), payload, Buffer.from("yyyy")]);
  const view = padded.subarray(4, 4 + payload.byteLength);
  // Buffer.concat 从池中分配，subarray 因此落在非零 byteOffset 上。
  expect(view.buffer).toBe(padded.buffer);
  expect(view.byteOffset).toBe(padded.byteOffset + 4);
  expect(view.byteOffset).toBeGreaterThan(0);
  expect(equalBytes(contentHash(view), contentHash(payload))).toBe(true);
  const plain = new Uint8Array(payload);
  expect(equalBytes(contentHash(plain), contentHash(payload))).toBe(true);
});

it("round-trips each digest into 64-char lowercase hex", () => {
  for (const digest of [
    contentHash(Buffer.from(MESSAGE, "utf8")),
    originalHash(Buffer.alloc(0)),
    bodyHash(BODY),
  ]) {
    const hex = hashToHex(digest);
    expect(hex).toBe(digest.toString("hex"));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(() => hashToHex(Buffer.alloc(HASH_BYTES - 1))).toThrow("IO_CAS_INVALID");
  expect(() => hashToHex(Buffer.alloc(HASH_BYTES + 1))).toThrow("IO_CAS_INVALID");
  expect(() => hashToHex("a".repeat(64) as unknown as Uint8Array)).toThrow("IO_CAS_INVALID");
});

it("compares byte content, not identity or length", () => {
  const left = Buffer.from("message-bytes", "utf8");
  expect(equalBytes(left, Buffer.from("message-bytes", "utf8"))).toBe(true);
  expect(equalBytes(left, new Uint8Array(left))).toBe(true);
  expect(equalBytes(left, Buffer.from("message-byteS", "utf8"))).toBe(false);
  expect(equalBytes(left, Buffer.from("message-byte", "utf8"))).toBe(false);
  expect(equalBytes(Buffer.alloc(0), Buffer.alloc(0))).toBe(true);
  const padded = Buffer.concat([Buffer.from([0]), left]);
  expect(equalBytes(padded.subarray(1), left)).toBe(true);
});
