import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = dirname(fileURLToPath(import.meta.url));
// mcpp publishes TypeScript sources. Bundle that dependency at build time so
// Node never has to strip types inside node_modules (unsupported in Node 22).
await build({
  absWorkingDir: packageDir,
  entryPoints: ["src/index.ts", "src/cli.ts"],
  outdir: "dist",
  platform: "node",
  target: "node22",
  format: "cjs",
  bundle: true,
  logLevel: "warning",
});
execFileSync("pnpm", ["exec", "tsc", "--noEmit", "false", "--emitDeclarationOnly"], {
  cwd: packageDir,
  stdio: "inherit",
});
