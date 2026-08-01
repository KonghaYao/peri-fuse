/**
 * `peri-fuse logs` — view the background server's log output.
 *
 * Default: print the last N lines. With -f/--follow: stream new lines as they
 * are appended (Node-based tail, cross-platform, no system `tail` dependency).
 */
import * as fs from "node:fs";
import { output } from "../lib/output";
import { logFile, readState } from "../lib/paths";

interface LogsOptions {
  lines?: string;
  follow?: boolean;
}

/** Read the last `n` lines of a file efficiently enough for our log sizes. */
function tailLines(file: string, n: number): string[] {
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n");
  // Drop a trailing empty element from a final newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

export async function logsCommand(opts: LogsOptions): Promise<void> {
  const state = readState();
  const file = state?.logFile ?? logFile();

  if (!fs.existsSync(file)) {
    output.info("No log file yet. Start the server first: peri-fuse start");
    return;
  }

  const n = opts.lines ? parseInt(opts.lines, 10) : 50;
  const count = Number.isFinite(n) && n > 0 ? n : 50;

  // Print the initial tail.
  for (const line of tailLines(file, count)) {
    output.plain(line);
  }

  if (!opts.follow) return;

  // Follow mode: watch for appends and print new content incrementally.
  output.dim(`\n--- following ${file} (Ctrl+C to stop) ---\n`);

  let offset = fs.statSync(file).size;

  const printNew = () => {
    const stat = fs.statSync(file);
    if (stat.size < offset) {
      // File was truncated/rotated — reset.
      offset = 0;
    }
    if (stat.size > offset) {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = stat.size;
      process.stdout.write(buf.toString("utf8"));
    }
  };

  fs.watch(file, () => {
    try {
      printNew();
    } catch {
      /* file may be mid-write; ignore */
    }
  });

  // Keep the process alive until interrupted.
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
}
