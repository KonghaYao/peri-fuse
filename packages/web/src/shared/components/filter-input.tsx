/**
 * FilterInput — Spectra §6.6 filter field.
 *
 * A controlled text/date filter that commits on Enter (or blur for dates),
 * shows a leading icon and an inline clear (×) button when active. The value
 * is URL-backed via useTableState, so this component keeps a local draft and
 * syncs it whenever the external (URL) value changes.
 */
import { type LucideIcon, Search, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Input } from "@/shared/components/ui/input";
import { cn } from "@/shared/lib/utils";

interface FilterInputProps {
  /** Current committed value from the URL (undefined = inactive). */
  value: string | undefined;
  /** Called with the new value (undefined to clear) on Enter / clear. */
  onCommit: (value: string | undefined) => void;
  icon?: LucideIcon;
  placeholder?: string;
  type?: "text" | "datetime-local";
  className?: string;
  title?: string;
}

/** Dates are stored in the URL as ISO strings but edited as "YYYY-MM-DDTHH:mm". */
function toDraft(v: string | undefined, isDate: boolean) {
  return isDate && v ? new Date(v).toISOString().slice(0, 16) : (v ?? "");
}

export function FilterInput({
  value,
  onCommit,
  icon: Icon = Search,
  placeholder,
  type = "text",
  className,
  title,
}: FilterInputProps) {
  const isDate = type === "datetime-local";

  const [draft, setDraft] = useState(() => toDraft(value, isDate));

  // Keep the draft in sync when the URL value changes externally
  // (e.g. Clear-all, back/forward navigation).
  useEffect(() => {
    setDraft(toDraft(value, isDate));
  }, [value, isDate]);

  const commitDraft = (raw: string) => {
    if (isDate) {
      onCommit(raw ? new Date(raw).toISOString() : undefined);
    } else {
      const trimmed = raw.trim();
      onCommit(trimmed === "" ? undefined : trimmed);
    }
  };

  return (
    <div className={cn("relative", className)}>
      <Icon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-tertiary" />
      <Input
        type={type}
        title={title}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          // Dates commit immediately (no Enter affordance on native pickers).
          if (isDate) commitDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitDraft((e.target as HTMLInputElement).value);
          if (e.key === "Escape") setDraft(toDraft(value, isDate));
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
