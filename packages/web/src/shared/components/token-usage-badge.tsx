/**
 * Port of web/src/components/token-usage-badge.tsx (usage-number branch only;
 * the observation branch depends on web's tRPC return types). Renders the
 * "12 → 34 (∑ 46)" token usage badge used by the traces table.
 */
import type { ReactNode } from "react";

import { Badge } from "@/shared/components/ui/badge";
import { numberFormatter } from "@/shared/lib/format";

export const TokenUsageBadge = (
  props: {
    inputUsage: number;
    outputUsage: number;
    totalUsage: number;
  } & {
    inline?: boolean;
    rightIcon?: ReactNode;
    variant?: "default" | "secondary" | "destructive" | "outline";
  },
) => {
  const usage = props;

  if (usage.inputUsage === 0 && usage.outputUsage === 0 && usage.totalUsage === 0) return null;

  const content = `${numberFormatter(usage.inputUsage, 0)} → ${numberFormatter(usage.outputUsage, 0)} (∑ ${numberFormatter(usage.totalUsage, 0)})`;

  if (props.inline)
    return (
      <span className="flex items-center gap-1">
        {content}
        {props.rightIcon}
      </span>
    );

  return (
    <Badge variant={props.variant ?? "outline"}>
      <span className="flex items-center gap-1">
        {content}
        {props.rightIcon}
      </span>
    </Badge>
  );
};
