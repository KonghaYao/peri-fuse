import type { Observation } from "@/shared/lib/types";

/** Matches the timeline's AGENT + subagent* convention, also accepting bg prefixes. */
export function isGraphSubagent(observation: Observation): boolean {
  return (
    observation.type === "AGENT" &&
    /^(?:(?:bg|background|async)[\s:._-]+)?subagent/i.test(observation.name ?? "")
  );
}

function hasBackgroundFlag(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === "string") {
    // Some SDKs serialize input/metadata. Only parse JSON containers, never prompt prose.
    if (!value.trimStart().startsWith("{")) return false;
    try {
      return hasBackgroundFlag(JSON.parse(value), depth + 1);
    } catch {
      // Malformed telemetry is untrusted display data; it cannot establish execution mode.
      return false;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [key, flag] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_\-.]/g, "");
    if (
      ["runinbackground", "background", "isbackground", "async", "isasync", "detached"].includes(
        normalized,
      ) &&
      (flag === true || flag === 1 || flag === "true" || flag === "1")
    ) {
      return true;
    }
    if (
      ["mode", "executionmode"].includes(normalized) &&
      typeof flag === "string" &&
      /^(background|async|detached)$/i.test(flag)
    ) {
      return true;
    }
    if (
      ["input", "metadata", "args", "arguments", "parameters", "options"].includes(normalized) &&
      hasBackgroundFlag(flag, depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Execution mode has no dedicated API field. Explicit input/metadata flags and
 * bg/background/async name tokens are the demo convention, never timing overlap.
 * A launcher TOOL may carry the flag; stop at the nearest TOOL/AGENT so nested
 * synchronous agents cannot accidentally inherit an outer background setting.
 */
export function isBackgroundSubagent(
  observation: Observation,
  byId: ReadonlyMap<string, Observation>,
): boolean {
  if (
    /\b(bg|background|async)\b/i.test((observation.name ?? "").replace(/_/g, " ")) ||
    hasBackgroundFlag(observation.metadata) ||
    hasBackgroundFlag(observation.input)
  ) {
    return true;
  }
  const seen = new Set([observation.id]);
  let parentId = observation.parentObservationId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent || parent.type === "AGENT") break;
    if (parent.type === "TOOL") {
      return hasBackgroundFlag(parent.metadata) || hasBackgroundFlag(parent.input);
    }
    parentId = parent.parentObservationId;
  }
  return false;
}
