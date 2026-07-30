/**
 * Level tints use the Spectra semantic tokens (DESIGN.md §2.2):
 * WARNING → warning, ERROR → danger, DEBUG → info.
 */

export type ObservationLevelType = "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";

export const LevelColors: Record<ObservationLevelType, { text: string; bg: string }> = {
  DEFAULT: { text: "", bg: "" },
  DEBUG: { text: "text-info", bg: "bg-info-subtle" },
  WARNING: {
    text: "text-warning",
    bg: "bg-warning-subtle",
  },
  ERROR: { text: "text-danger", bg: "bg-danger-subtle" },
};

export const LevelSymbols: Record<ObservationLevelType, string> = {
  DEFAULT: "ℹ️",
  DEBUG: "🔍",
  WARNING: "⚠️",
  ERROR: "🚨",
};

export const formatAsLabel = (countLabel: string) => {
  return countLabel.replace(/Count$/, "").toUpperCase() as ObservationLevelType;
};
