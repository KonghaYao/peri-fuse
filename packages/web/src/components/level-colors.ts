/**
 * Port of web/src/components/level-colors.tsx for the lite theme.
 *
 * The lite theme does not ship the web app's custom status tokens
 * (text-dark-yellow etc.), so level tints use the built-in Tailwind palette —
 * matching the convention already used by lite-web's Badge variants.
 */

export type ObservationLevelType = "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";

export const LevelColors: Record<ObservationLevelType, { text: string; bg: string }> = {
  DEFAULT: { text: "", bg: "" },
  DEBUG: { text: "text-muted-foreground", bg: "bg-muted" },
  WARNING: {
    text: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500/15",
  },
  ERROR: { text: "text-red-600 dark:text-red-400", bg: "bg-red-500/15" },
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
