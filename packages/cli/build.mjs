/**
 * Build script for @peri-fuse/cli.
 *
 * 1. Compiles CLI TypeScript sources with tsc.
 * 2. Bundles the server entry (packages/server/src/index.ts) into dist/server.cjs
 *    using esbuild so the published CLI is self-contained.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, "../server/src/index.ts");

// Step 1: compile CLI sources
console.log("[cli build] Compiling TypeScript…");
execFileSync("npx", ["tsc"], { cwd: __dirname, stdio: "inherit" });

// Step 2: bundle server into a single CJS file
console.log("[cli build] Bundling server…");
await esbuild.build({
  entryPoints: [serverEntry],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(__dirname, "dist/server.cjs"),
  // Native modules cannot be bundled — keep as external requires.
  external: ["better-sqlite3"],
  // Suppress warnings from node: protocol imports and dynamic requires.
  logLevel: "warning",
});

// Step 3: copy migration SQL files so the bundled server can create tables.
// - shared's findPackageRoot() walks up from __dirname (dist/) → finds cli/package.json → reads cli/drizzle/
// - gateway's findMigrationSql() checks __dirname/../drizzle/ → reads cli/dist/drizzle/
console.log("[cli build] Copying migration SQL…");
const sharedDrizzle = path.resolve(__dirname, "../shared/drizzle");
const gatewayDrizzle = path.resolve(__dirname, "../gateway/drizzle");
const sharedSearch = path.resolve(__dirname, "../shared/dist/src/server/session-search");
if (fs.existsSync(sharedSearch)) {
  fs.cpSync(sharedSearch, path.join(__dirname, "dist/src/server/session-search"), {
    recursive: true,
  });
}

// Shared migrations → <cli>/drizzle/
fs.cpSync(sharedDrizzle, path.join(__dirname, "drizzle"), { recursive: true });
// Gateway migrations → <cli>/dist/drizzle/
fs.cpSync(gatewayDrizzle, path.join(__dirname, "dist/drizzle"), { recursive: true });

// Keep the Langfuse skill available in the published, self-contained CLI.
const langfuseSkill = path.resolve(__dirname, "../langfuse-mcp/skills/langfuse");
if (fs.existsSync(path.join(langfuseSkill, "SKILL.md"))) {
  console.log("[cli build] Copying Langfuse skill resources…");
  fs.cpSync(langfuseSkill, path.join(__dirname, "dist/skills/langfuse"), {
    recursive: true,
  });
}

// Step 4: copy web SPA build so the bundled server can serve the frontend.
// Server checks __dirname/web/ first (bundled), then ../../web/dist (monorepo).
const webDist = path.resolve(__dirname, "../web/dist");
if (fs.existsSync(path.join(webDist, "index.html"))) {
  console.log("[cli build] Copying web SPA…");
  fs.cpSync(webDist, path.join(__dirname, "dist/web"), { recursive: true });
} else {
  console.log("[cli build] Web dist not found — skipping (API-only package).");
}

console.log("[cli build] Done ✓");
