import {
  immediate,
  MIGRATION_BUSINESS_DEGRADE_RATIO,
  MIGRATION_DISK_RESERVE_BYTES,
  MIGRATION_LOCK_WAIT_P95_MS,
  MIGRATION_WINDOW_MS,
  type MigrationDatabase,
} from "./migration-shared";

/**
 * 回填 / expand 的停止条件与速率控制（W7 ⑦）。
 *
 * 四类停止原因，均在**批与批之间**判定，当前批次提交完成后才暂停：
 * `pause-requested`（SIGINT/SIGTERM/pause file）、`disk-reserve`（可用磁盘低于预留）、
 * `lock-wait-p95`（本作业自身写锁等待 p95 > 50ms）、`business-p95`（业务延迟代理 p95
 * 比基线恶化 >20%）。后两者都要求窗口跨度 ≥60s 且样本数 ≥`minSamples`，
 * 避免冷启动噪声误暂停。
 *
 * 「业务 p95」的数据源：本命令是独立进程，仓库没有请求延迟指标端点，因此默认用
 * **空 `IMMEDIATE` 事务往返**（摄取路径的写锁延迟代理，见 `probeWriteLatency`）作为
 * 业务延迟；需要接入外部指标时用 `businessBaselineMs` 给出基线，判定口径不变。
 * 基线缺省时用**首个完整窗口**的 p95 自校准（相对恶化判定），不再依赖人工输入。
 */

export interface MigrationStopOptions {
  /** 显式暂停：信号处理或 pause file。 */
  pauseRequested?: () => boolean;
  /** 可用磁盘字节；省略 = 不判定。 */
  diskFreeBytes?: () => number;
  diskReserveBytes?: number;
  lockWaitP95Ms?: number;
  businessDegradeRatio?: number;
  windowMs?: number;
  /** 窗口内最少样本数（默认 20）；不足视为「数据不足」，不暂停。 */
  minSamples?: number;
  /** 业务 p95 基线（ms）；省略时用首个完整窗口的 p95 自校准。 */
  businessBaselineMs?: number;
  now?: () => number;
}

interface Sample {
  at: number;
  lockWaitMs?: number;
  businessMs?: number;
}

function percentile(values: (number | undefined)[], fraction: number): number | undefined {
  const sorted = values
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export class MigrationStops {
  private readonly samples: Sample[] = [];
  private readonly pauseRequested: () => boolean;
  private readonly diskFreeBytes?: () => number;
  private readonly diskReserveBytes: number;
  private readonly lockWaitLimitMs: number;
  private readonly businessDegradeRatio: number;
  private readonly windowMs: number;
  private readonly minSamples: number;
  private readonly now: () => number;
  private baseline?: number;

  constructor(options: MigrationStopOptions = {}) {
    this.pauseRequested = options.pauseRequested ?? (() => false);
    this.diskFreeBytes = options.diskFreeBytes;
    this.diskReserveBytes = options.diskReserveBytes ?? MIGRATION_DISK_RESERVE_BYTES;
    this.lockWaitLimitMs = options.lockWaitP95Ms ?? MIGRATION_LOCK_WAIT_P95_MS;
    this.businessDegradeRatio = options.businessDegradeRatio ?? MIGRATION_BUSINESS_DEGRADE_RATIO;
    this.windowMs = options.windowMs ?? MIGRATION_WINDOW_MS;
    this.minSamples = options.minSamples ?? 20;
    this.now = options.now ?? (() => performance.now());
    this.baseline = options.businessBaselineMs;
  }

  get businessBaselineMs(): number | undefined {
    return this.baseline;
  }

  get lockWaitP95Ms(): number | undefined {
    return percentile(
      this.window().map((sample) => sample.lockWaitMs),
      0.95,
    );
  }

  get businessP95Ms(): number | undefined {
    return percentile(
      this.window().map((sample) => sample.businessMs),
      0.95,
    );
  }

  record(sample: { lockWaitMs?: number; businessMs?: number }): void {
    this.samples.push({ at: this.now(), ...sample });
  }

  /** 返回停止原因码；`undefined` = 继续。 */
  reason(): string | undefined {
    if (this.pauseRequested()) return "pause-requested";
    if (this.diskFreeBytes) {
      const free = this.diskFreeBytes();
      if (Number.isFinite(free) && free < this.diskReserveBytes) return "disk-reserve";
    }
    const window = this.window();
    if (!this.covered(window)) return undefined;
    const lockWait = percentile(
      window.map((sample) => sample.lockWaitMs),
      0.95,
    );
    if (lockWait !== undefined && lockWait > this.lockWaitLimitMs) return "lock-wait-p95";
    const business = percentile(
      window.map((sample) => sample.businessMs),
      0.95,
    );
    if (business === undefined) return undefined;
    if (this.baseline === undefined) {
      this.baseline = business;
      return undefined;
    }
    if (business > this.baseline * (1 + this.businessDegradeRatio)) return "business-p95";
    return undefined;
  }

  private window(): Sample[] {
    const cutoff = this.now() - this.windowMs;
    return this.samples.filter((sample) => sample.at >= cutoff);
  }

  private covered(window: Sample[]): boolean {
    return window.length >= this.minSamples && this.now() - window[0].at >= this.windowMs;
  }
}

/** 速率上限：累积原文 / 累积时间的**平均值**不超限，不做突发配额。 */
export class RateLimiter {
  private bytes = 0;
  private readonly startedAt: number;

  constructor(
    private readonly bytesPerSecond: number,
    private readonly now: () => number,
    private readonly sleep: (milliseconds: number) => Promise<void>,
  ) {
    this.startedAt = now();
  }

  async pace(bytes: number): Promise<void> {
    this.bytes += bytes;
    const elapsed = this.now() - this.startedAt;
    const target = (this.bytes / this.bytesPerSecond) * 1000;
    if (target > elapsed) await this.sleep(target - elapsed);
  }
}

/** 业务延迟代理：一次空 `IMMEDIATE` 事务的完整往返（含写锁等待）。 */
export async function probeWriteLatency(db: MigrationDatabase): Promise<number> {
  const started = performance.now();
  await immediate(db, async () => undefined);
  return performance.now() - started;
}
