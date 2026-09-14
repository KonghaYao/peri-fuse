import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
type PackageManifest = {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
};

function manifest(directory: string): PackageManifest {
  return JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
}

describe("clean workspace build order", () => {
  it("builds every workspace runtime dependency before its consumer", () => {
    const rootBuild = manifest(repoRoot).scripts?.build ?? "";
    const order = [...rootBuild.matchAll(/--filter\s+(\S+)\s+run\s+build/g)].map(
      (match) => match[1],
    );
    const packages = readdirSync(resolve(repoRoot, "packages"), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(resolve(repoRoot, "packages", entry.name, "package.json")),
      )
      .map((entry) => manifest(resolve(repoRoot, "packages", entry.name)))
      .filter((pkg) => pkg.scripts?.build);
    const names = new Set(packages.map((pkg) => pkg.name));

    for (const pkg of packages) {
      expect(order, `Missing build step for ${pkg.name}`).toContain(pkg.name);
      for (const dependency of Object.keys(pkg.dependencies ?? {})) {
        if (!names.has(dependency)) continue;
        expect(
          order.indexOf(dependency),
          `${pkg.name} needs ${dependency}'s built exports in a clean checkout`,
        ).toBeLessThan(order.indexOf(pkg.name));
      }
    }
  });
});
