import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { LocalCache } from "../cache/localCache";
import { InMemoryCacheAdapter } from "./in-memory-cache-adapter";

const retained = (cache: object) =>
  (cache as { cache: { size: number; calculatedSize: number } }).cache;

describe("cache memory bounds", () => {
  it("accounts for Unicode keys and values and evicts within the byte budget", async () => {
    const cache = new InMemoryCacheAdapter({ max: 100, maxBytes: 200 });
    await cache.set("中文", "你".repeat(30));
    await cache.set("second", "你".repeat(30));
    expect(await cache.get("中文")).toBeNull();
    expect(await cache.get("second")).toBe("你".repeat(30));
    expect(retained(cache).calculatedSize).toBeLessThanOrEqual(200);
    await cache.set("too large", "x".repeat(1000));
    expect(await cache.exists("too large")).toBe(false);
    await cache.close();
    expect(retained(cache).size).toBe(0);
  });

  it("purges expired entries without requiring reads", async () => {
    const cache = new InMemoryCacheAdapter({ ttlMs: 15 });
    await cache.set("key", "value");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(retained(cache).size).toBe(0);
    await cache.close();
  });

  it("keeps cache byte accounting stable after caller mutations, including Buffer views", () => {
    const cache = new LocalCache<{ value: string; date: Date; bytes: Buffer }>({
      namespace: "owned",
      enabled: true,
      max: 10,
      ttlMs: 1000,
      maxBytes: 1000,
    });
    const data = { value: "small", date: new Date(1000), bytes: Buffer.from([1, 2]) };
    cache.set("key", data);
    const accounted = retained(cache).calculatedSize;
    data.value = "x".repeat(1_000_000);
    data.date.setTime(9999);
    data.bytes[0] = 99;
    const result = cache.get("key")!;
    expect(result.value).toBe("small");
    expect(result.date).toEqual(new Date(1000));
    expect(result.bytes).toEqual(Buffer.from([1, 2]));
    result.value = "y".repeat(1_000_000);
    result.bytes[0] = 42;
    expect(cache.get("key")?.value).toBe("small");
    expect(cache.get("key")?.bytes).toEqual(Buffer.from([1, 2]));
    expect(retained(cache).calculatedSize).toBe(accounted);
    cache.clear();
  });

  it("bypasses unsupported domain instances without changing loader values", async () => {
    const cache = new LocalCache<{ price: Decimal }>({
      namespace: "domain",
      enabled: true,
      max: 10,
      ttlMs: 1000,
      maxBytes: 1000,
    });
    const value = { price: new Decimal("1.2345") };
    const result = await cache.getOrLoad("key", async () => ({ value }));
    expect(result.value).toBe(value);
    expect(result.value?.price.plus(1).toString()).toBe("2.2345");
    expect(cache.get("key")).toBeUndefined();
    expect(retained(cache).size).toBe(0);
    cache.clear();
  });

  it("bounds object payloads in LocalCache and releases expired entries", async () => {
    const cache = new LocalCache<{ data: string }>({
      namespace: "test",
      enabled: true,
      max: 100,
      ttlMs: 15,
      maxBytes: 500,
    });
    cache.set("a", { data: "x".repeat(100) });
    cache.set("b", { data: "x".repeat(100) });
    expect(retained(cache).calculatedSize).toBeLessThanOrEqual(500);
    expect(cache.get("a")).toBeUndefined();
    cache.set("oversized", { data: "x".repeat(1000) });
    expect(cache.get("oversized")).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(retained(cache).size).toBe(0);
    cache.clear();
  });
});
