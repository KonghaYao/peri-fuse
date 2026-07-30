/**
 * Port of web/src/components/table/table-id.tsx — truncated id/name cell.
 */
import { cn } from "@/shared/lib/utils";

export default function TableIdOrName({ value, className }: { value: string; className?: string }) {
  return (
    <div
      title={value}
      className={cn(
        "inline-block max-w-full overflow-hidden rounded py-0.5 text-xs text-nowrap text-ellipsis",
        className,
      )}
    >
      {value}
    </div>
  );
}
