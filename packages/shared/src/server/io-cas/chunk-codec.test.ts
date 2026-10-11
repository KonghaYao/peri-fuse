import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { CAS_MAX_BYTES, decodeChunk } from "./chunk-codec";

const TEXT = `{"role":"user","content":"你好🌍"}\r\n`.repeat(64);

it("returns raw codec 0 bytes unchanged when the length matches", () => {
  const payload = Buffer.from(TEXT, "utf8");
  const decoded = decodeChunk({ codec: 0, rawSize: payload.byteLength, payload });
  expect(decoded).toBe(payload);
  expect(Buffer.from(decoded).toString("utf8")).toBe(TEXT);
  expect(decodeChunk({ codec: 0, rawSize: 0, payload: Buffer.alloc(0) })).toHaveLength(0);
});

it("rejects raw codec 0 with a length that contradicts the payload", () => {
  const payload = Buffer.from(TEXT, "utf8");
  expect(() => decodeChunk({ codec: 0, rawSize: payload.byteLength - 1, payload })).toThrow(
    "IO_CAS_CORRUPT",
  );
  expect(() => decodeChunk({ codec: 0, rawSize: payload.byteLength + 1, payload })).toThrow(
    "IO_CAS_CORRUPT",
  );
  expect(() =>
    decodeChunk({
      codec: 0,
      rawSize: payload.byteLength,
      payload: Buffer.concat([payload, Buffer.from("\n")]),
    }),
  ).toThrow("IO_CAS_CORRUPT");
  expect(() => decodeChunk({ codec: 0, rawSize: 0, payload: Buffer.from("x") })).toThrow(
    "IO_CAS_CORRUPT",
  );
});

it("round-trips deflate codec 1 and verifies the declared raw size", () => {
  const payload = deflateSync(Buffer.from(TEXT, "utf8"));
  const rawSize = Buffer.byteLength(TEXT, "utf8");
  const decoded = decodeChunk({ codec: 1, rawSize, payload });
  expect(Buffer.from(decoded).toString("utf8")).toBe(TEXT);
  expect(() => decodeChunk({ codec: 1, rawSize: rawSize - 1, payload })).toThrow("IO_CAS_CORRUPT");
  expect(() => decodeChunk({ codec: 1, rawSize: rawSize + 1, payload })).toThrow("IO_CAS_CORRUPT");
});

it("rejects a declared size that is smaller than the real output (decompression bomb)", () => {
  const payload = deflateSync(Buffer.alloc(64 * 1024, 0x61));
  expect(() => decodeChunk({ codec: 1, rawSize: 1024, payload })).toThrow("IO_CAS_CORRUPT");
  expect(() => decodeChunk({ codec: 1, rawSize: 0, payload })).toThrow("IO_CAS_CORRUPT");
});

it("rejects truncated, extended and non-deflate compressed inputs", () => {
  const payload = deflateSync(Buffer.from(TEXT, "utf8"));
  const rawSize = Buffer.byteLength(TEXT, "utf8");
  expect(() => decodeChunk({ codec: 1, rawSize, payload: payload.subarray(1) })).toThrow(
    "IO_CAS_CORRUPT",
  );
  expect(() =>
    decodeChunk({ codec: 1, rawSize, payload: Buffer.concat([payload, Buffer.from([0])]) }),
  ).toThrow("IO_CAS_CORRUPT");
  expect(() => decodeChunk({ codec: 1, rawSize, payload: Buffer.from("not-deflate") })).toThrow(
    "IO_CAS_CORRUPT",
  );
  expect(() => decodeChunk({ codec: 1, rawSize, payload: Buffer.alloc(0) })).toThrow(
    "IO_CAS_CORRUPT",
  );
});

it("rejects unknown codecs and out-of-range sizes with distinct codes", () => {
  const payload = Buffer.from(TEXT, "utf8");
  for (const codec of [2, 9, -1, 1.5]) {
    expect(() => decodeChunk({ codec, rawSize: payload.byteLength, payload })).toThrow(
      "IO_CAS_VERSION",
    );
  }
  for (const rawSize of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => decodeChunk({ codec: 0, rawSize, payload })).toThrow("IO_CAS_INVALID");
  }
  expect(() => decodeChunk({ codec: 0, rawSize: CAS_MAX_BYTES + 1, payload })).toThrow(
    "IO_CAS_LIMIT",
  );
  expect(() => decodeChunk({ codec: 1, rawSize: CAS_MAX_BYTES + 1, payload })).toThrow(
    "IO_CAS_LIMIT",
  );
});

it("rejects missing or non-binary payloads", () => {
  for (const payload of [
    null,
    undefined,
    "text",
    new ArrayBuffer(4),
    new DataView(new ArrayBuffer(4)),
  ]) {
    expect(() =>
      decodeChunk({ codec: 0, rawSize: 4, payload: payload as unknown as Uint8Array }),
    ).toThrow("IO_CAS_INVALID");
  }
  expect(() => decodeChunk(undefined as unknown as Parameters<typeof decodeChunk>[0])).toThrow(
    "IO_CAS_INVALID",
  );
});

it("accepts a codec 1 chunk whose decoded size is declared as zero", () => {
  const payload = deflateSync(Buffer.alloc(0));
  const decoded = decodeChunk({ codec: 1, rawSize: 0, payload });
  expect(decoded.byteLength).toBe(0);
});

it("accepts a codec 1 chunk exactly at CAS_MAX_BYTES", () => {
  const raw = Buffer.alloc(CAS_MAX_BYTES, 0x7a);
  const payload = deflateSync(raw);
  const decoded = decodeChunk({ codec: 1, rawSize: CAS_MAX_BYTES, payload });
  expect(decoded.byteLength).toBe(CAS_MAX_BYTES);
});
