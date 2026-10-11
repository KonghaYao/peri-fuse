import { assertReadSnapshotSupported, type LocalDatabase } from "../../db/local";
import { getTelemetryDB } from "../adapters";
import { logger } from "../logger";
import { startMaintenanceLoop } from "../stats/maintenance-loop";
import {
  type CasGcStepOptions,
  discoverCasGcProjects,
  ensureCasRootsIndex,
  runCasGcStep,
} from "./gc";

/**
 * CAS 池 GC 的维护作业与 pass 调度（W6）。单步状态机与索引/项目发现见 `gc.ts`。
 *
 * - `PERIFUSE_IO_CAS_GC=off`（**默认**）时 `startCasGcJob` / `requestCasGcPass` 都是 no-op，
 *   行为与现状完全一致；`on` 时默认每 6h 一轮，并在 retention 完成后被请求立即补一轮。
 * - 引擎不具备 W1 快照能力（Turso local / remote）时**拒绝启动**：记错误、返回 no-op，
 *   绝不"绕过门禁继续跑"。
 * - pass 有界（总步数 / 单项目步数 / 时间预算），批间让出事件循环；超预算的部分留到下一轮，
 *   游标已持久化，续跑不丢进度。
 */

/** 默认巡检间隔：每项目 6 小时。 */
export const CAS_GC_INTERVAL_MS = 6 * 3600_000;
/** 单次 pass 的默认步数/时间预算（批间让出，超预算下轮续跑）。 */
export const CAS_GC_PASS_MAX_STEPS = 16_384;
export const CAS_GC_PASS_MAX_STEPS_PER_PROJECT = 4_096;
export const CAS_GC_PASS_BUDGET_MS = 30_000;

export interface CasGcConfig {
  enabled: boolean;
}

/** 解析 `PERIFUSE_IO_CAS_GC`（`off|on`，默认 off）；非法值抛 `IO_CAS_INVALID_CONFIG`。 */
export function resolveCasGcConfig(environment: NodeJS.ProcessEnv = process.env): CasGcConfig {
  const raw = environment.PERIFUSE_IO_CAS_GC;
  if (raw !== undefined && raw !== "off" && raw !== "on") throw new Error("IO_CAS_INVALID_CONFIG");
  return { enabled: raw === "on" };
}

export interface CasGcPassOptions {
  signal?: AbortSignal;
  /** pass 内总步数上限；默认 16384。 */
  maxSteps?: number;
  /** 单项目步数上限（防止大项目饿死其他项目）；默认 4096。 */
  maxStepsPerProject?: number;
  /** pass 时间上限（毫秒）；默认 30s。 */
  budgetMs?: number;
  /** 批间让出的实现（测试可注入 no-op）。 */
  yieldBetween?: () => Promise<void> | void;
  step?: CasGcStepOptions;
}

export interface CasGcPassResult {
  projects: number;
  steps: number;
  roots: number;
  marked: number;
  swept: number;
  blocked: string[];
  indexCreated: boolean;
  indexMs: number;
  budgetExhausted: boolean;
  elapsedMs: number;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 一次有界的 GC pass：门禁 → 建索引（幂等，记耗时）→ 项目发现 → 逐项目跑状态机。
 *
 * 预算（总步数 / 单项目步数 / 时间）只约束"每个项目第一步之后"的额外推进：
 * 预算耗尽时**每个项目仍会拿到一步**，因此大项目不会把其他项目永久饿死；
 * 超预算的部分留到下一轮，游标已持久化，续跑不丢进度。批间让出事件循环。
 */
export async function runCasGcPass(
  db: LocalDatabase,
  options: CasGcPassOptions = {},
): Promise<CasGcPassResult> {
  assertReadSnapshotSupported(db);
  const started = performance.now();
  const maxSteps = Math.max(1, options.maxSteps ?? CAS_GC_PASS_MAX_STEPS);
  const maxStepsPerProject = Math.max(
    1,
    options.maxStepsPerProject ?? CAS_GC_PASS_MAX_STEPS_PER_PROJECT,
  );
  const budgetMs = Math.max(1, options.budgetMs ?? CAS_GC_PASS_BUDGET_MS);
  const yieldBetween = options.yieldBetween ?? yieldToEventLoop;
  const index = await ensureCasRootsIndex(db);
  const projects = await discoverCasGcProjects(db);
  const result: CasGcPassResult = {
    projects: projects.length,
    steps: 0,
    roots: 0,
    marked: 0,
    swept: 0,
    blocked: [],
    indexCreated: index.created,
    indexMs: index.elapsedMs,
    budgetExhausted: false,
    elapsedMs: 0,
  };
  for (const projectId of projects) {
    let steps = 0;
    while (steps < maxStepsPerProject) {
      if (options.signal?.aborted) {
        result.budgetExhausted = true;
        result.elapsedMs = performance.now() - started;
        return result;
      }
      if (steps > 0 && (result.steps >= maxSteps || performance.now() - started > budgetMs)) {
        result.budgetExhausted = true;
        break;
      }
      const step = await runCasGcStep(db, projectId, options.step);
      steps += 1;
      result.steps += 1;
      result.roots += step.roots;
      result.marked += step.marked;
      result.swept += step.swept;
      if (step.blocked !== null && !result.blocked.includes(`${projectId}:${step.blocked}`))
        result.blocked.push(`${projectId}:${step.blocked}`);
      if (step.done) break;
      await yieldBetween();
    }
    if (steps >= maxStepsPerProject) result.budgetExhausted = true;
  }
  result.elapsedMs = performance.now() - started;
  return result;
}

type MaintenanceStop = (() => Promise<void>) & { request: () => void };

const noopStop: MaintenanceStop = Object.assign(async () => {}, { request: () => {} });

let activeJob: MaintenanceStop | null = null;

export interface CasGcJobOptions {
  intervalMs?: number;
  pass?: CasGcPassOptions;
  onError?: (error: unknown) => void;
}

/**
 * 启动 GC 维护作业（默认 6h 一轮；`PERIFUSE_IO_CAS_GC=off` 时不启动）。
 *
 * 返回的函数可停止作业；其 `.request()` 请求在当前 pass 之后立即再跑一轮
 * （retention 完成后的"请求一次"、或运维手动触发）。重复请求合并，不排队堆积。
 */
export function startCasGcJob(options: CasGcJobOptions = {}): MaintenanceStop {
  if (!resolveCasGcConfig().enabled) return noopStop;
  const adapter = getTelemetryDB();
  const db = adapter.getDatabase?.() as LocalDatabase | undefined;
  try {
    if (!db) throw new Error("PERIFUSE_READ_SNAPSHOT_UNSUPPORTED");
    assertReadSnapshotSupported(db);
  } catch (error) {
    logger.error("[cas-gc] Refusing to start: engine is not verified for GC", error);
    return noopStop;
  }
  const pass = async (signal: AbortSignal) => {
    const summary = await runCasGcPass(db, { ...options.pass, signal });
    if (summary.steps > 0 || summary.blocked.length > 0)
      logger.info(
        `[cas-gc] Pass done: projects=${summary.projects} steps=${summary.steps} roots=${summary.roots} marked=${summary.marked} swept=${summary.swept} blocked=${summary.blocked.length} indexMs=${Math.round(summary.indexMs)} elapsedMs=${Math.round(summary.elapsedMs)}`,
      );
    for (const blocked of summary.blocked)
      logger.error(
        `[cas-gc] Project blocked on a corrupt root; GC stops for it until reset: ${blocked}`,
      );
  };
  const stop = startMaintenanceLoop(
    pass,
    pass,
    options.intervalMs ?? CAS_GC_INTERVAL_MS,
    options.onError ?? ((error) => logger.error("[cas-gc] Maintenance failed", error)),
  );
  activeJob = stop;
  return Object.assign(
    async () => {
      if (activeJob === stop) activeJob = null;
      await stop();
    },
    { request: () => stop.request() },
  );
}

/**
 * retention 完成后请求一次 GC（也供运维调用）。GC 关闭或作业未启动时是 no-op；
 * 作业正在跑 pass 时合并成"结束后再来一轮"。
 */
export function requestCasGcPass(): void {
  if (!resolveCasGcConfig().enabled) return;
  activeJob?.request();
}

/** 仅测试/运维使用：当前是否已有活动作业。 */
export function casGcJobActive(): boolean {
  return activeJob !== null;
}
