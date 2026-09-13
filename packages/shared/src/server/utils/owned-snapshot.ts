import { deserialize, serialize } from "node:v8";

/** Custom prototypes/accessors can lose domain behavior when cloned; reject them explicitly. */
export class UnsupportedSnapshotError extends Error {}

const viewPrototypes = new Set([
  Buffer.prototype,
  DataView.prototype,
  Int8Array.prototype,
  Uint8Array.prototype,
  Uint8ClampedArray.prototype,
  Int16Array.prototype,
  Uint16Array.prototype,
  Int32Array.prototype,
  Uint32Array.prototype,
  Float32Array.prototype,
  Float64Array.prototype,
  BigInt64Array.prototype,
  BigUint64Array.prototype,
]);

/**
 * Encode an owned snapshot without silently flattening domain instances (Decimal,
 * class instances, etc.). Built-in dates, maps, sets and typed arrays retain their
 * types; shared buffers and accessor properties are intentionally unsupported.
 */
export function encodeOwnedSnapshot(value: unknown): Buffer {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== "object") continue;
    if (seen.has(item)) continue;
    seen.add(item);
    const prototype = Object.getPrototypeOf(item);
    if (Object.getOwnPropertySymbols(item).length) {
      throw new UnsupportedSnapshotError("Symbol properties cannot be safely retained");
    }
    if (ArrayBuffer.isView(item)) {
      if (!viewPrototypes.has(prototype) || item.buffer instanceof SharedArrayBuffer) {
        throw new UnsupportedSnapshotError("Unsupported or shared buffer in retained value");
      }
      continue;
    }
    if ([Date.prototype, ArrayBuffer.prototype, Map.prototype, Set.prototype].includes(prototype)) {
      if (Reflect.ownKeys(item).length) {
        throw new UnsupportedSnapshotError("Custom built-in properties cannot be safely retained");
      }
    }
    if (prototype === Date.prototype || prototype === ArrayBuffer.prototype) continue;
    if (prototype === Map.prototype) {
      for (const [key, entry] of item as Map<unknown, unknown>) pending.push(key, entry);
      continue;
    }
    if (prototype === Set.prototype) {
      for (const entry of item as Set<unknown>) pending.push(entry);
      continue;
    }
    if (prototype !== Object.prototype && prototype !== Array.prototype) {
      throw new UnsupportedSnapshotError("Custom domain prototypes cannot be safely retained");
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (!descriptor.enumerable && !(prototype === Array.prototype && key === "length")) {
        throw new UnsupportedSnapshotError("Non-enumerable properties cannot be safely retained");
      }
      if (descriptor.get || descriptor.set) {
        throw new UnsupportedSnapshotError("Accessor properties cannot be safely retained");
      }
      pending.push(descriptor.value);
    }
  }
  return serialize(value);
}

/**
 * Deserialize from a copy: V8 may make typed-array views over its input buffer,
 * so exposing a decode of the private buffer would permit mutation of the cache.
 */
export function decodeOwnedSnapshot<T>(snapshot: Buffer): T {
  return deserialize(Buffer.from(snapshot)) as T;
}
