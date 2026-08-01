/**
 * Colored console output helpers for the Peri-Fuse CLI.
 */
import pc from "picocolors";

export const output = {
  info(msg: string): void {
    console.log(pc.cyan("ℹ"), msg);
  },
  success(msg: string): void {
    console.log(pc.green("✔"), msg);
  },
  warn(msg: string): void {
    console.log(pc.yellow("⚠"), msg);
  },
  error(msg: string): void {
    console.error(pc.red("✖"), msg);
  },
  dim(msg: string): void {
    console.log(pc.dim(msg));
  },
  plain(msg: string): void {
    console.log(msg);
  },
};

/** Format a millisecond duration into a human-readable string. */
export function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}
