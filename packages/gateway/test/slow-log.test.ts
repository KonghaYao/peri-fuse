/**
 * Slow log unit tests — threshold judgment and file writer.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isSlow } from "../src/slow-log/judge.js";
import type { SlowLogEvent } from "../src/slow-log/types.js";

describe("isSlow", () => {
  it("marks latency above threshold as slow", () => {
    expect(isSlow({ latencyMs: 101 }, 100)).toBe(true);
  });

  it("does not mark latency at or below the threshold", () => {
    expect(isSlow({ latencyMs: 100 }, 100)).toBe(false);
    expect(isSlow({ latencyMs: 99 }, 100)).toBe(false);
  });

  it("judges streaming calls by TTFT only (total duration grows with output length)", () => {
    expect(isSlow({ latencyMs: 500, ttftMs: 150, stream: true }, 100)).toBe(true);
    expect(isSlow({ latencyMs: 500, ttftMs: 50, stream: true }, 100)).toBe(false);
  });

  it("judges non-streaming calls by total latency", () => {
    expect(isSlow({ latencyMs: 500, ttftMs: 150, stream: false }, 100)).toBe(true);
    expect(isSlow({ latencyMs: 90, ttftMs: 80, stream: false }, 100)).toBe(false);
  });

  it("falls back to total latency when TTFT is missing", () => {
    expect(isSlow({ latencyMs: 120, stream: true }, 100)).toBe(true);
    expect(isSlow({ latencyMs: 90, stream: true }, 100)).toBe(false);
  });
});

describe("SlowLogWriter", () => {
  let tmpDir: string;

  const logFiles = (): string[] =>
    fs.readdirSync(tmpDir).filter((f) => f.startsWith("slow-") && f.endsWith(".log"));

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slow-log-test-"));
    process.env.GATEWAY_SLOW_LOG_DIR = tmpDir;
    process.env.GATEWAY_SLOW_LOG_THRESHOLD_MS = "100";
    process.env.GATEWAY_SLOW_LOG_RETENTION_DAYS = "7";
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes slow requests as JSONL to the daily file", async () => {
    const { slowLogWriter } = await import("../src/slow-log/writer.js");
    slowLogWriter.writeIfSlow({
      projectId: "p1",
      callType: "chat",
      model: "gpt-4o",
      endTime: new Date(),
      latencyMs: 250,
      ttftMs: 150,
      stream: true,
      promptTokens: 10,
      completionTokens: 20,
      spend: 0.01,
    } satisfies SlowLogEvent);
    await slowLogWriter.close();

    expect(logFiles()).toHaveLength(1);
    const content = fs.readFileSync(path.join(tmpDir, logFiles()[0]), "utf8");
    const line = JSON.parse(content.trim());
    expect(line.projectId).toBe("p1");
    expect(line.model).toBe("gpt-4o");
    expect(line.latencyMs).toBe(250);
    expect(line.ttftMs).toBe(150);
    expect(line.stream).toBe(true);
    expect(line.thresholdMs).toBe(100);
    expect(line.spend).toBe(0.01);
  });

  it("does not write calls at or below the threshold", async () => {
    const { slowLogWriter } = await import("../src/slow-log/writer.js");
    slowLogWriter.writeIfSlow({
      projectId: "p1",
      callType: "chat",
      model: "gpt-4o",
      endTime: new Date(),
      latencyMs: 50,
    } satisfies SlowLogEvent);
    await slowLogWriter.close();

    expect(logFiles()).toHaveLength(1); // only the file from the previous test
    const content = fs.readFileSync(path.join(tmpDir, logFiles()[0]), "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
  });

  it("cleans up log files older than the retention window", async () => {
    const { slowLogWriter } = await import("../src/slow-log/writer.js");
    const oldFile = path.join(tmpDir, "slow-2020-01-01.log");
    fs.writeFileSync(oldFile, "{}");
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, past, past);

    slowLogWriter.cleanup();
    await slowLogWriter.close();

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(logFiles()).toHaveLength(1); // current file is kept
  });
});
