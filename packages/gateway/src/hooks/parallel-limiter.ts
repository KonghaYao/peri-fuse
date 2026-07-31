/**
 * Parallel request limiter hook — limits concurrent in-flight requests per API key.
 */
import type { CallResult, GatewayHook, HookContext } from "./types.js";
import { HookRejectError } from "./types.js";

// In-flight request counters per key
const inFlight = new Map<string, number>();

export const parallelLimiterHook: GatewayHook = {
  name: "parallel-limiter",

  async preCall(ctx: HookContext): Promise<void> {
    const { apiKey } = ctx;
    const maxParallel = apiKey.maxParallel;

    if (maxParallel != null && maxParallel > 0) {
      const key = apiKey.id;
      const current = inFlight.get(key) ?? 0;

      if (current >= maxParallel) {
        throw new HookRejectError(
          `Parallel request limit reached: ${current}/${maxParallel} concurrent requests`,
          429,
          1,
        );
      }

      inFlight.set(key, current + 1);
    }
  },

  async postSuccess(_ctx: HookContext, _result: CallResult): Promise<void> {
    decrement(_ctx.apiKey.id);
  },

  async postFailure(_ctx: HookContext, _error: Error): Promise<void> {
    decrement(_ctx.apiKey.id);
  },
};

function decrement(keyId: string): void {
  const current = inFlight.get(keyId) ?? 0;
  if (current <= 1) {
    inFlight.delete(keyId);
  } else {
    inFlight.set(keyId, current - 1);
  }
}
