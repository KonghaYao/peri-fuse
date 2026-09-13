/** Hook dispatch with per-request acquisition and exactly-once completion. */
import type { CallResult, GatewayHook, HookContext } from "./types.js";

type HookRun = { acquired: GatewayHook[]; settled: boolean };

export class HookRegistry {
  private hooks: GatewayHook[] = [];
  private runs = new WeakMap<HookContext, HookRun>();

  register(hook: GatewayHook): void {
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    this.hooks = this.hooks.filter((h) => h.name !== name);
  }

  async runPreCall(ctx: HookContext): Promise<void> {
    const run: HookRun = { acquired: [], settled: false };
    this.runs.set(ctx, run);
    try {
      for (const hook of this.hooks) {
        await hook.preCall?.(ctx);
        run.acquired.push(hook);
      }
    } catch (error) {
      // The rejecting hook did not acquire its resource. In particular, rejecting
      // a parallel-limit check must not release another request's slot.
      this.runPostFailure(ctx, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  runPostSuccess(ctx: HookContext, result: CallResult): void {
    const run = this.settle(ctx);
    if (!run) return;
    for (const hook of run.acquired) {
      this.dispatch(hook, "postSuccess", () => hook.postSuccess?.(ctx, result));
    }
  }

  runPostFailure(ctx: HookContext, error: Error): void {
    const run = this.settle(ctx);
    if (!run) return;
    for (const hook of [...run.acquired].reverse()) {
      this.dispatch(hook, "postFailure", () => hook.postFailure?.(ctx, error));
    }
  }

  private settle(ctx: HookContext): HookRun | undefined {
    const run = this.runs.get(ctx);
    if (!run || run.settled) return undefined;
    run.settled = true;
    return run;
  }

  private dispatch(hook: GatewayHook, phase: string, call: () => Promise<void> | undefined) {
    try {
      call()?.catch((error) => console.error(`[hook:${hook.name}] ${phase} error:`, error));
    } catch (error) {
      console.error(`[hook:${hook.name}] ${phase} error:`, error);
    }
  }
}

export const hookRegistry = new HookRegistry();
