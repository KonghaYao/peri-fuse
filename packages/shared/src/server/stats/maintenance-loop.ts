/** A maintenance pass schedules its successor only after it finishes. Stop cancels future work. */
export type MaintenanceStop = (() => Promise<void>) & {
  /**
   * 请求立刻补跑一轮 `refresh`：正在跑的 pass 结束后立即执行（多次请求合并成一轮），
   * 处于等待间隔时打断等待立即开跑。停止后请求无效。
   */
  request: () => void;
};

export function startMaintenanceLoop(
  initial: (signal: AbortSignal) => Promise<unknown>,
  refresh: (signal: AbortSignal) => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
): MaintenanceStop {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void>;
  let pending = false;
  let stopped = false;
  const schedule = (pass: (signal: AbortSignal) => Promise<unknown>, delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      active = run(pass);
    }, delayMs);
    timer.unref?.();
  };
  const run = async (pass: (signal: AbortSignal) => Promise<unknown>) => {
    try {
      await pass(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
    }
    if (stopped || controller.signal.aborted) return;
    // 请求补跑优先于常规定时：迟到的一次 request 不会等到下一个 interval。
    if (pending) {
      pending = false;
      schedule(refresh, 0);
    } else {
      schedule(refresh, intervalMs);
    }
  };
  active = run(initial);
  const stop = async () => {
    stopped = true;
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    await active;
  };
  return Object.assign(stop, {
    request: () => {
      if (stopped) return;
      // timer 未设置 ⟺ 有 pass 在跑：合并成"结束后再来一轮"。
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        active = run(refresh);
        return;
      }
      pending = true;
    },
  });
}
