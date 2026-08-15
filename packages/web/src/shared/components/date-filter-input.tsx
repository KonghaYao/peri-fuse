/**
 * DateFilterInput — 检索栏日期筛选（社区标准：Popover + Calendar）。
 *
 * URL 中存储 ISO 字符串（UTC）。选择日期时按 boundary 语义提交：
 *   - start: 当天 00:00:00.000Z（from 筛选）
 *   - end:   当天 23:59:59.999Z（to 筛选）
 * 显示时转换为本地日期，避免时区偏移造成"日期跳一天"。
 */
import { Calendar as CalendarIcon, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/shared/components/ui/button";
import { Calendar } from "@/shared/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/components/ui/popover";
import { cn } from "@/shared/lib/utils";

interface DateFilterInputProps {
  /** Committed ISO value from the URL (undefined = inactive). */
  value: string | undefined;
  /** Called with the new ISO value (undefined to clear). */
  onCommit: (value: string | undefined) => void;
  placeholder?: string;
  title?: string;
  /** "start" = 当天 00:00:00.000Z，"end" = 当天 23:59:59.999Z。默认 "start"。 */
  boundary?: "start" | "end";
  className?: string;
}

/** ISO → 本地 Date（无效值返回 undefined）。 */
function toLocalDate(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 本地日期 → 按 boundary 语义生成 UTC ISO 字符串。 */
function toIso(date: Date, boundary: "start" | "end"): string {
  if (boundary === "end") {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      23,
      59,
      59,
      999,
    ).toISOString();
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

/** 本地日期 → "2026-08-15" 显示格式。 */
function formatDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function DateFilterInput({
  value,
  onCommit,
  placeholder = "Select date…",
  title,
  boundary = "start",
  className,
}: DateFilterInputProps) {
  const [open, setOpen] = useState(false);
  const selected = toLocalDate(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          title={title}
          className={cn(
            "h-8 w-full justify-start gap-2 px-3 font-normal",
            selected ? "text-fg-primary" : "text-fg-tertiary hover:text-fg-secondary",
            className,
          )}
        >
          <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-fg-tertiary" />
          <span className="flex-1 truncate text-left">
            {selected ? formatDay(selected) : placeholder}
          </span>
          {selected && (
            <X
              role="button"
              aria-label={`Clear ${title ?? "date filter"}`}
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onCommit(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onCommit(undefined);
                }
              }}
              className="h-3.5 w-3.5 shrink-0 cursor-pointer rounded-sm text-fg-tertiary transition-colors hover:text-fg-primary"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            if (date) {
              onCommit(toIso(date, boundary));
              setOpen(false);
            }
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
