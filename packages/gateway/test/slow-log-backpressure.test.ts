import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlowLogEvent } from "../src/slow-log/types.js";

function event(day = 1): SlowLogEvent {
  return {
    projectId: "bounded-slow-log",
    callType: "chat",
    model: "test-model",
    endTime: new Date(Date.UTC(2026, 8, day)),
    latencyMs: 1000,
  };
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("slow log backpressure and shutdown", () => {
  let directory: string;
  let SlowLogWriter: typeof import("../src/slow-log/writer.js").SlowLogWriter;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "gateway-slow-bounded-"));
    process.env.GATEWAY_SLOW_LOG_DIR = directory;
    ({ SlowLogWriter } = await import("../src/slow-log/writer.js"));
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("drops while write() signals backpressure, retains a fixed buffer and resumes on drain", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let completeWrite: (() => void) | undefined;
    const written: string[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        completeWrite = callback;
      },
    });
    const writer = new SlowLogWriter({ createStream: () => stream });
    expect(writer.write(event())).toBe(true);
    const initialBytes = writer.stats().bufferedBytes;
    for (let i = 0; i < 10_000; i++) expect(writer.write(event())).toBe(false);
    expect(writer.stats()).toEqual({ dropped: 10_000, bufferedBytes: initialBytes, streams: 1 });
    expect(written).toHaveLength(1);
    completeWrite!();
    await nextTick();
    expect(writer.write(event())).toBe(true);
    completeWrite!();
    await writer.close();
    expect(written).toHaveLength(2);
    expect(writer.stats().bufferedBytes).toBe(0);
  });

  it("bounds pending rotation streams and finishes shutdown even when the disk never drains", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const streams: Writable[] = [];
    const writer = new SlowLogWriter({
      closeTimeoutMs: 20,
      createStream: () => {
        const stream = new Writable({
          highWaterMark: 1,
          write() {
            // Simulates filesystem writes that never invoke their callback.
          },
        });
        streams.push(stream);
        return stream;
      },
    });
    expect(writer.write(event(1))).toBe(true);
    expect(writer.write(event(2))).toBe(true);
    for (let day = 3; day <= 30; day++) expect(writer.write(event(day))).toBe(false);
    expect(streams).toHaveLength(2);
    expect(writer.stats().streams).toBe(2);
    expect(writer.stats().bufferedBytes).toBeLessThanOrEqual(2 * 64 * 1024);
    const closing = writer.close();
    expect(writer.close()).toBe(closing);
    expect(writer.write(event(2))).toBe(false);
    await closing;
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
    expect(writer.stats().streams).toBe(0);
  });

  it("caps individual log fields before serializing and recovers after a stream error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const streams: Writable[] = [];
    const lines: string[] = [];
    const writer = new SlowLogWriter({
      createStream: () => {
        const stream = new Writable({
          write(chunk, _encoding, callback) {
            lines.push(chunk.toString());
            callback();
          },
        });
        streams.push(stream);
        return stream;
      },
    });
    expect(writer.write({ ...event(), errorMessage: "x".repeat(1_000_000) })).toBe(true);
    expect(JSON.parse(lines[0]).errorMessage).toHaveLength(2048);
    streams[0].destroy(new Error("injected log failure"));
    await nextTick();
    expect(writer.write(event())).toBe(true);
    await writer.close();
    expect(streams).toHaveLength(2);
  });
});
