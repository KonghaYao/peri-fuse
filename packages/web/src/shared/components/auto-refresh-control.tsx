/**
 * AutoRefreshControl — Spectra §9 live-data cadence picker.
 *
 * A compact ghost button (spinning icon while active) with a dropdown of
 * polling cadences. The choice is global + persisted (auto-refresh store)
 * and picked up by every list query via `refetchInterval`.
 */
import { Check, RefreshCw } from "lucide-react";

import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import {
  REFRESH_OPTIONS,
  setRefreshInterval,
  useRefreshInterval,
} from "@/shared/store/auto-refresh";

const LABELS: Record<number, string> = {
  0: "Off",
  15000: "15s",
  30000: "30s",
  60000: "1m",
};

export function AutoRefreshControl() {
  const interval = useRefreshInterval();
  const active = interval > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("gap-1.5 text-fg-secondary", active && "text-brand")}
          title="Auto-refresh interval"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", active && "animate-[spin_3s_linear_infinite]")} />
          <span className="text-xs">{LABELS[interval] ?? "Off"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuLabel className="text-xs font-medium text-fg-tertiary">
          Auto-refresh
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {REFRESH_OPTIONS.map((ms) => (
          <DropdownMenuItem key={ms} onSelect={() => setRefreshInterval(ms)}>
            <span>{LABELS[ms]}</span>
            {interval === ms && <Check className="ml-auto h-3.5 w-3.5 text-brand" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
