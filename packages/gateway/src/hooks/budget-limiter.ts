/**
 * Budget limiter hook — checks key budget before allowing requests.
 */
import type { GatewayHook, HookContext } from "./types.js";
import { HookRejectError } from "./types.js";

export const budgetLimiterHook: GatewayHook = {
  name: "budget-limiter",

  async preCall(ctx: HookContext): Promise<void> {
    const { apiKey } = ctx;

    // Check key-level max budget
    if (apiKey.maxBudget != null && apiKey.maxBudget > 0) {
      if (apiKey.spend >= apiKey.maxBudget) {
        throw new HookRejectError(
          `Budget limit reached: spent $${apiKey.spend.toFixed(4)} of $${apiKey.maxBudget.toFixed(4)} limit`,
          429,
        );
      }
    }
  },
};
