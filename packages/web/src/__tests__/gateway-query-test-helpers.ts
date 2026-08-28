import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { vi } from "vitest";
import type { GatewayQuerySnapshot } from "@/features/gateway/components/gateway-query-state";

/** Query test adapter shared by Gateway page tests. */
export interface TestGatewayQuery<T> extends GatewayQuerySnapshot<T> {
  refetch: () => Promise<unknown>;
}

/** Create a deterministic Gateway query handle for page-level rendering tests. */
export function gatewayQuery<T>(
  data: T | undefined,
  overrides: Partial<GatewayQuerySnapshot<T>> = {},
): TestGatewayQuery<T> {
  return {
    data,
    error: null,
    isPending: data === undefined,
    isFetching: data === undefined,
    refetch: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** Collect nested React elements without requiring a DOM test environment. */
export function reactElements(node: ReactNode): ReactElement[] {
  const found: ReactElement[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    found.push(child);
    found.push(...reactElements((child.props as { children?: ReactNode }).children));
  });
  return found;
}

/** Evaluate one function component layer for event-prop inspection in Node tests. */
export function renderFunctionElement(node: ReactNode): ReactNode {
  if (!isValidElement(node)) throw new Error("Expected a function component element");
  const { type, props } = node;
  if (typeof type !== "function") throw new Error("Expected a function component element");
  return (type as (componentProps: typeof props) => ReactNode)(props);
}
