/** Display helpers shared by the downloaded analysis scripts. */
export function fmt(n: number) {
  return n.toLocaleString();
}
export function pct(part: number, whole: number) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "-";
}
export function bar(percent: number, width = 20) {
  const filled = Math.round((percent / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
export function ms(seconds: number) {
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${(seconds % 60).toFixed(0)}s`;
}
export function isoToLocal(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.valueOf())
    ? iso.slice(0, 16)
    : date.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
