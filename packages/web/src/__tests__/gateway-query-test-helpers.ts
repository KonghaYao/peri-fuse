import { vi } from "vitest";
import type { GatewayQueryHandle } from "@/features/gateway/components/gateway-query-section";

type QueryOptions = {
  error?: unknown;
  isPending?: boolean;
  isFetching?: boolean;
};

export function gatewayQuery<T>(data?: T, options: QueryOptions = {}): GatewayQueryHandle<T> {
  return {
    data,
    error: options.error ?? null,
    isPending: options.isPending ?? data === undefined,
    isFetching: options.isFetching ?? data === undefined,
    refetch: vi.fn(async () => undefined),
  };
}
