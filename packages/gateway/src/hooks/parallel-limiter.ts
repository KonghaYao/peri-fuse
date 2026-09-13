/**
 * Parallel request limiter hook — limits concurrent in-flight requests per API key.
 */
import type { CallResult, GatewayHook, HookContext } from "./types.js";
import { HookRejectError } from "./types.js";

// In-flight request counters per key
const inFlight = new Map<string, number>();
const acquired = new WeakSet<HookContext>();
const keyFor = (ctx: HookContext) => JSON.stringify([ctx.projectId, ctx.apiKey.id]);

export const parallelLimiterHook: GatewayHook = {
  name: "parallel-limiter",

  async preCall(ctx: HookContext): Promise<void> {
    const { apiKey } = ctx;
    const maxParallel = apiKey.maxParallel;

    if (maxParallel != null && maxParallel > 0) {
      const key = keyFor(ctx);
      const current = inFlight.get(key) ?? 0;

      if (current >= maxParallel) {
        throw new HookRejectError(
          `Parallel request limit reached: ${current}/${maxParallel} concurrent requests`,
          429,
          1,
        );
      }

      inFlight.set(key, current + 1);
      acquired.add(ctx);
    }
  },

  async postSuccess(_ctx: HookContext, _result: CallResult): Promise<void> {
    decrement(_ctx);
  },

  async postFailure(_ctx: HookContext, _error: Error): Promise<void> {
    decrement(_ctx);
  },
};

function decrement(ctx: HookContext): void {
  if (!acquired.delete(ctx)) return;
  const keyId = keyFor(ctx);
  const current = inFlight.get(keyId) ?? 0;
  if (current <= 1) {
    inFlight.delete(keyId);
  } else {
    inFlight.set(keyId, current - 1);
  }
}
