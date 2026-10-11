/**
 * Observation noise helpers — `isNoiseObservation` marks the `stage-*` spans
 * that add little signal, and `OmitNoiseToggle` drives the filter for the views
 * that still offer it (the session page timeline).
 */

import { Filter } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import type { Observation } from "@/shared/lib/types";
import { cn } from "@/shared/lib/utils";

/**
 * Observations that are pure intermediate noise: `stage-*` spans — agent
 * internal phases (stage-reason / stage-act / ...) that add little signal on
 * top of the agent -> tool/generation chain.
 *
 * `tool-batch*` wrappers are NOT filtered here: they carry real tool-call
 * children. The timeline filters them on its own.
 *
 * ERROR-level observations are always kept: even a noise node can carry a
 * failure signal (statusMessage) that must stay visible.
 */
export function isNoiseObservation(o: Observation): boolean {
  if (o.level === "ERROR") return false;
  return o.name?.startsWith("stage-") ?? false;
}

/**
 * Toggle for the noise-omission behaviour of the views that still offer the
 * filter (the page timeline). Active (default) means noise nodes (stage-*
 * spans) are hidden.
 */
export function OmitNoiseToggle({
  omitNoise,
  onChange,
}: {
  omitNoise: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-7 w-7", omitNoise && "bg-brand-subtle text-brand")}
      onClick={() => onChange(!omitNoise)}
      title={omitNoise ? "隐藏噪音节点（stage-*）" : "显示全部节点"}
      aria-pressed={omitNoise}
    >
      <Filter className="h-3.5 w-3.5" />
    </Button>
  );
}
