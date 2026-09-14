import { AutoRefreshIntervalControl } from "@peri/ui";
import type { Component } from "solid-js";
import {
  REFRESH_OPTIONS,
  setRefreshInterval,
  useRefreshInterval,
} from "@/shared/store/auto-refresh";

/** Thin wrapper wiring the global refresh store to @peri/ui. */
export const AutoRefreshControl: Component = () => {
  const interval = useRefreshInterval();
  return (
    <AutoRefreshIntervalControl
      value={interval()}
      options={[...REFRESH_OPTIONS]}
      onChange={setRefreshInterval}
    />
  );
};
