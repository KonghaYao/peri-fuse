/**
 * Rate limiter hook — RPM/TPM sliding window checks.
 */
import type { CallResult, GatewayHook, HookContext } from "./types.js";
import { HookRejectError } from "./types.js";
import { SlidingWindowCounter } from "../utils/sliding-window.js";

const rpmCounter = new SlidingWindowCounter();
const tpmCounter = new SlidingWindowCounter();

const WINDOW_MS = 60_000; // 1 minute

export const rateLimiterHook: GatewayHook = {
  name: "rate-limiter",

  async preCall(ctx: HookContext): Promise<void> {
    const { apiKey } = ctx;
    const rpmLimit = apiKey.rpmLimit;

    if (rpmLimit != null && rpmLimit > 0) {
      const key = `rpm:${apiKey.id}`;
      const allowed = rpmCounter.checkAndIncrement(key, rpmLimit, WINDOW_MS);
      if (!allowed) {
        const resetTime = rpmCounter.getResetTime(key, WINDOW_MS);
        const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);
        throw new HookRejectError(
          `Rate limit exceeded: ${rpmLimit} requests per minute`,
          429,
          retryAfter,
        );
      }
    }
  },

  async postSuccess(ctx: HookContext, result: CallResult): Promise<void> {
    const { apiKey } = ctx;
    const tpmLimit = apiKey.tpmLimit;

    if (tpmLimit != null && tpmLimit > 0) {
      const key = `tpm:${apiKey.id}`;
      tpmCounter.incrementBy(key, result.totalTokens, WINDOW_MS);
    }
  },
};
