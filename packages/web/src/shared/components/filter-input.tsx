/**
 * FilterInput — Spectra §6.6 filter field.
 *
 * A controlled text filter that commits on Enter, shows a leading icon and an
 * inline clear (×) button when active. The value is URL-backed via
 * useTableState, so this component keeps a local draft and syncs it whenever
 * the external (URL) value changes.
 *
 * 日期筛选见 DateFilterInput（Popover + Calendar，社区标准）。
 */
import { type LucideIcon, Search, X } from "lucide-react";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";

import { Input } from "@/shared/components/ui/input";
import { cn } from "@/shared/lib/utils";

/** 供筛选栏的 Search 按钮触发提交（等价按 Enter）。 */
export interface FilterInputHandle {
  commit: () => void;
}

interface FilterInputProps {
  /** Current committed value from the URL (undefined = inactive). */
  value: string | undefined;
  /** Called with the new value (undefined to clear) on Enter / clear. */
  onCommit: (value: string | undefined) => void;
  icon?: LucideIcon;
  placeholder?: string;
  className?: string;
  title?: string;
  ref?: Ref<FilterInputHandle>;
}

export function FilterInput({
  value,
  onCommit,
  icon: Icon = Search,
  placeholder,
  className,
  title,
  ref,
}: FilterInputProps) {
  const [draft, setDraft] = useState(value ?? "");

  // Keep the draft in sync when the URL value changes externally
  // (e.g. Clear-all, back/forward navigation).
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  const commitDraft = (raw: string) => {
    const trimmed = raw.trim();
    onCommit(trimmed === "" ? undefined : trimmed);
  };
  const commitDraftRef = useRef(commitDraft);
  commitDraftRef.current = commitDraft;

  // Expose commit() to the parent's Search button; draftRef keeps the
  // latest draft without re-creating the handle on every keystroke.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useImperativeHandle(ref, () => ({ commit: () => commitDraftRef.current(draftRef.current) }), []);

  return (
    <div className={cn("relative", className)}>
      <Icon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-tertiary" />
      <Input
        title={title}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitDraft((e.target as HTMLInputElement).value);
          if (e.key === "Escape") setDraft(value ?? "");
        }}
        className={cn("pl-8", draft && "pr-8")}
      />
      {draft && (
        <button
          type="button"
          onClick={() => {
            setDraft("");
            onCommit(undefined);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-fg-tertiary transition-colors hover:text-fg-primary"
          aria-label={`Clear ${placeholder ?? "filter"}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
