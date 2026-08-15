/**
 * FilterSelect — 检索栏选择筛选（Radix Select 的检索语义封装）。
 *
 * 规范检索行为：
 *   - 内部 ALL 哨兵值：value=undefined 时显示 "All xxx"，选择 ALL 时提交 undefined
 *   - 统一 h-8 高度与宽度，与 FilterInput/DateFilterInput 视觉对齐
 *   - 选项变化立即提交（URL-backed via useTableState）
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { cn } from "@/shared/lib/utils";

const ALL = "__all__";

interface FilterSelectOption {
  value: string;
  label: string;
}

interface FilterSelectProps {
  /** Current committed value from the URL (undefined = "All"). */
  value: string | undefined;
  /** Called with the new value (undefined = "All") on selection. */
  onCommit: (value: string | undefined) => void;
  /** Placeholder shown when no option matches (e.g. during data load). */
  placeholder?: string;
  /** Label of the "All" option, e.g. "All types". */
  allLabel: string;
  options: FilterSelectOption[];
  className?: string;
  title?: string;
}

export function FilterSelect({
  value,
  onCommit,
  placeholder,
  allLabel,
  options,
  className,
  title,
}: FilterSelectProps) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onCommit(v !== ALL ? v : undefined)}>
      <SelectTrigger title={title} className={cn("h-8 w-40", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
