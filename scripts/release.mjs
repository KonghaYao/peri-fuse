#!/usr/bin/env node
/**
 * Release script for the peri-fuse CLI.
 *
 * Bumps the version, commits, tags, and pushes — the v* tag then triggers
 * .github/workflows/npm-publish.yml, which publishes the package to npm.
 *
 * Usage:
 *   pnpm release patch        # 0.4.1 -> 0.4.2
 *   pnpm release minor        # 0.4.1 -> 0.5.0
 *   pnpm release major        # 0.4.1 -> 1.0.0
 *   pnpm release 0.4.3        # explicit version
 *   pnpm release patch --dry-run   # preview without changing anything
 *
 * Safety checks:
 *   - must be on `main` with a clean working tree
 *   - refuses to reuse an existing version or tag
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const cliPkgPath = path.join(root, "packages/cli/package.json");

const bump = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!bump) {
  console.error("Usage: pnpm release <patch|minor|major|semver> [--dry-run]");
  process.exit(1);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
}

function log(action) {
  console.log(dryRun ? `[dry-run] ${action}` : action);
}

// 1. Safety checks
const branch = run("git", ["branch", "--show-current"]);
if (branch !== "main") {
  console.error(`Release must run on main (current branch: ${branch || "(detached)"})`);
  process.exit(1);
}
const dirty = run("git", ["status", "--porcelain"]);
if (dirty) {
  console.error(`Working tree is not clean — commit or stash changes first:\n${dirty}`);
  process.exit(1);
}

// 2. Compute next version
const pkg = JSON.parse(fs.readFileSync(cliPkgPath, "utf8"));
const current = pkg.version;
let next;
if (/^\d+\.\d+\.\d+$/.test(bump)) {
  next = bump;
} else {
  const [major, minor, patch] = current.split(".").map(Number);
  if (bump === "patch") next = `${major}.${minor}.${patch + 1}`;
  else if (bump === "minor") next = `${major}.${minor + 1}.0`;
  else if (bump === "major") next = `${major + 1}.0.0`;
  else {
    console.error(
      `Unknown bump "${bump}" — use patch, minor, major, or an explicit version like 0.4.3`,
    );
    process.exit(1);
  }
}
if (next === current) {
  console.error(`Version is already ${current} — nothing to release`);
  process.exit(1);
}
const tag = `v${next}`;
if (run("git", ["tag", "-l", tag])) {
  console.error(`Tag ${tag} already exists — delete it or pick another version`);
  process.exit(1);
}

console.log(`Releasing peri-fuse ${current} -> ${next} (${dryRun ? "dry run" : "for real"})`);

// 3. Bump version
if (dryRun) {
  log(`would update packages/cli/package.json: ${current} -> ${next}`);
} else {
  pkg.version = next;
  fs.writeFileSync(cliPkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  log(`updated packages/cli/package.json: ${current} -> ${next}`);
}

// 4. Commit, tag, push
const steps = [
  ["git", ["add", "packages/cli/package.json"]],
  ["git", ["commit", "-m", `chore: release peri-fuse v${next}`]],
  ["git", ["tag", "-a", tag, "-m", `peri-fuse v${next}`]],
  ["git", ["push", "origin", branch]],
  ["git", ["push", "origin", tag]],
];
for (const [cmd, args] of steps) {
  log(`$ ${cmd} ${args.join(" ")}`);
  if (dryRun) continue;
  try {
    run(cmd, args);
  } catch {
    console.error(`\nFailed: ${cmd} ${args.join(" ")}`);
    console.error("Fix the issue, then finish manually:");
    console.error(`  git push origin ${branch} && git push origin ${tag}`);
    console.error("(the version bump and tag are already in place locally)");
    process.exit(1);
  }
}

let actionsUrl = "your GitHub Actions tab";
try {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const repo = remote.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
  actionsUrl = `https://github.com/${repo}/actions`;
} catch {
  // no remote — keep the fallback text
}

console.log(`\nDone — released v${next}. CI will publish to npm:`);
console.log(`  ${actionsUrl}`);
