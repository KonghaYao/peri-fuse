/**
 * Hook registry — manages hook lifecycle and dispatch.
 */
import type { CallResult, GatewayHook, HookContext } from "./types.js";

class HookRegistry {
  private hooks: GatewayHook[] = [];

  register(hook: GatewayHook): void {
    this.hooks.push(hook);
  }

  unregister(name: string): void {
    this.hooks = this.hooks.filter((h) => h.name !== name);
  }

  /**
   * Run all preCall hooks sequentially.
   * If any hook throws, the request is rejected.
   */
  async runPreCall(ctx: HookContext): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.preCall) {
        await hook.preCall(ctx);
      }
    }
  }

  /**
   * Run all postSuccess hooks concurrently (fire-and-forget).
   * Errors are logged but do not propagate.
   */
  runPostSuccess(ctx: HookContext, result: CallResult): void {
    for (const hook of this.hooks) {
      if (hook.postSuccess) {
        hook.postSuccess(ctx, result).catch((err) => {
          console.error(`[hook:${hook.name}] postSuccess error:`, err);
        });
      }
    }
  }

  /**
   * Run all postFailure hooks concurrently (fire-and-forget).
   */
  runPostFailure(ctx: HookContext, error: Error): void {
    for (const hook of this.hooks) {
      if (hook.postFailure) {
        hook.postFailure(ctx, error).catch((err) => {
          console.error(`[hook:${hook.name}] postFailure error:`, err);
        });
      }
    }
  }
}

export const hookRegistry = new HookRegistry();
