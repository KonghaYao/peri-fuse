import {
  Bot,
  CircleDot,
  Fan,
  Layers3,
  Link,
  ListTree,
  type LucideIcon,
  MoveHorizontal,
  Search,
  ShieldCheck,
  WandSparkles,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Shared badge styling for observation type and level, used by the
 * observations list and the trace-detail tree.
 *
 * Type colors mirror the main Langfuse app's `ItemBadge` palette (see
 * web/src/components/ItemBadge.tsx): GENERATION is magenta, SPAN blue,
 * EVENT green, AGENT purple, TOOL orange, and so on.
 */

type TypeStyle = { icon: LucideIcon; text: string; badge: string };

const typeStyles: Record<string, TypeStyle> = {
  SPAN: {
    icon: MoveHorizontal,
    text: "text-blue-600 dark:text-blue-400",
    badge: "border-blue-500/30 bg-blue-500/10",
  },
  EVENT: {
    icon: CircleDot,
    text: "text-green-600 dark:text-green-400",
    badge: "border-green-500/30 bg-green-500/10",
  },
  GENERATION: {
    icon: Fan,
    text: "text-fuchsia-600 dark:text-fuchsia-400",
    badge: "border-fuchsia-500/30 bg-fuchsia-500/10",
  },
  AGENT: {
    icon: Bot,
    text: "text-purple-600 dark:text-purple-400",
    badge: "border-purple-500/30 bg-purple-500/10",
  },
  TOOL: {
    icon: Wrench,
    text: "text-orange-600 dark:text-orange-400",
    badge: "border-orange-500/30 bg-orange-500/10",
  },
  CHAIN: {
    icon: Link,
    text: "text-pink-600 dark:text-pink-400",
    badge: "border-pink-500/30 bg-pink-500/10",
  },
  RETRIEVER: {
    icon: Search,
    text: "text-teal-600 dark:text-teal-400",
    badge: "border-teal-500/30 bg-teal-500/10",
  },
  EVALUATOR: {
    icon: WandSparkles,
    text: "text-indigo-600 dark:text-indigo-400",
    badge: "border-indigo-500/30 bg-indigo-500/10",
  },
  EMBEDDING: {
    icon: Layers3,
    text: "text-amber-600 dark:text-amber-500",
    badge: "border-amber-500/30 bg-amber-500/10",
  },
  GUARDRAIL: {
    icon: ShieldCheck,
    text: "text-red-600 dark:text-red-400",
    badge: "border-red-500/30 bg-red-500/10",
  },
};

const fallbackStyle: TypeStyle = {
  icon: ListTree,
  text: "text-muted-foreground",
  badge: "border-border bg-muted",
};

export function observationTypeStyle(type: string): TypeStyle {
  return typeStyles[type] ?? fallbackStyle;
}

/** Colored outline badge with the type's icon and name. */
export function ObservationTypeBadge({ type }: { type: string }) {
  const { icon: Icon, text, badge } = observationTypeStyle(type);
  return (
    <Badge variant="outline" className={cn("gap-1 px-1.5 font-medium", badge, text)}>
      <Icon className="h-3 w-3" />
      {type}
    </Badge>
  );
}

/** Bare colored type icon, used by the trace-detail observation tree. */
export function ObservationTypeIcon({ type, className }: { type: string; className?: string }) {
  const { icon: Icon, text } = observationTypeStyle(type);
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", text, className)} />;
}

export function LevelBadge({ level }: { level: string | null }) {
  if (!level) return <span className="text-muted-foreground">—</span>;
  const variant =
    level === "ERROR"
      ? "error"
      : level === "WARNING"
        ? "warning"
        : level === "DEBUG"
          ? "muted"
          : "secondary";
  return <Badge variant={variant}>{level}</Badge>;
}
