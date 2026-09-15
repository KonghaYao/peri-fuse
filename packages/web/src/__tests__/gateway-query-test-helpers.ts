import { vi } from "vitest";
import type { QueryHandle } from "@peri/ui";

type QueryOptions = {
  error?: unknown;
  isPending?: boolean;
  isFetching?: boolean;
};

export function gatewayQuery<T>(data?: T, options: QueryOptions = {}): QueryHandle<T> {
  return {
    data,
    error: options.error ?? null,
    isPending: options.isPending ?? data === undefined,
    isFetching: options.isFetching ?? data === undefined,
    refetch: vi.fn(async () => undefined),
  };
}
