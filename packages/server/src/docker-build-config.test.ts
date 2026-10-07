import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/docker-ghcr.yml"), "utf8");

describe("Docker multi-platform release", () => {
  it("publishes AMD64 and ARM64 images in the same build", () => {
    const buildStep = workflow
      .split(/\n\s+- name:/)
      .find((step) => step.includes("uses: docker/build-push-action@"));
    expect(buildStep).toBeDefined();
    const platforms = buildStep?.match(/^\s+platforms:\s*(.+)$/m)?.[1];
    expect(platforms?.split(",").map((platform) => platform.trim())).toEqual([
      "linux/amd64",
      "linux/arm64",
    ]);
    expect(buildStep).toMatch(/^\s+push:\s*true$/m);
  });

  it("sets up ARM64 emulation before creating the builder", () => {
    const qemuStep = workflow
      .split(/\n\s+- name:/)
      .find((step) => step.includes("uses: docker/setup-qemu-action@"));
    expect(qemuStep).toMatch(/^\s+platforms:\s*arm64$/m);
    expect(workflow.indexOf("uses: docker/setup-qemu-action@")).toBeLessThan(
      workflow.indexOf("uses: docker/setup-buildx-action@"),
    );
    expect(workflow.indexOf("uses: docker/setup-buildx-action@")).toBeLessThan(
      workflow.indexOf("uses: docker/build-push-action@"),
    );
  });
});

describe("Docker dependency patches", () => {
  it("copies SDK patches before installing build and runtime dependencies", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");
    for (const stageName of ["deps", "production-deps"]) {
      const stage = dockerfile
        .split(/^FROM /m)
        .find((contents) => contents.startsWith(`base AS ${stageName}\n`));
      expect(stage).toBeDefined();
      const patchCopy = stage?.indexOf("COPY patches ./patches") ?? -1;
      const install = stage?.indexOf("pnpm install") ?? -1;
      expect(patchCopy).toBeGreaterThanOrEqual(0);
      expect(install).toBeGreaterThan(patchCopy);
    }
  });
});

describe("Docker Bun runtime", () => {
  it("runs the server on Bun with patched production dependencies", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");
    const runtime = dockerfile
      .split(/^FROM /m)
      .find((stage) => /^oven\/bun:\S+-debian AS runtime\n/.test(stage));
    expect(runtime).toBeDefined();
    expect(runtime).toContain("COPY --from=production-deps /app /app");
    expect(runtime).toContain('CMD ["bun", "packages/server/dist/index.js"]');
    expect(runtime).toContain("NODE_BINARY=bun");
    expect(runtime).not.toContain("pnpm install");
    expect(runtime).not.toContain("corepack");
  });
});
