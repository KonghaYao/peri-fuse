import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const periStudioRoot = path.resolve(rootDir, "../../vendor/peri-studio");

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(rootDir, "src") },
      {
        find: /^@peri\/ui$/,
        replacement: path.join(rootDir, "src/test/peri-ui-stub.tsx"),
      },
      {
        find: /^@peri\/ui\/styles\.css$/,
        replacement: path.join(periStudioRoot, "packages/ui/src/styles/index.css"),
      },
      {
        find: /^@peri\/markdown$/,
        replacement: path.join(periStudioRoot, "packages/markdown/src"),
      },
      {
        find: /^@peri\/markdown\/worker$/,
        replacement: path.join(
          periStudioRoot,
          "packages/markdown/src/workers/mermaidParser.worker.ts",
        ),
      },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
