import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const periStudioRoot = path.resolve(rootDir, "../../vendor/peri-studio");

// The lite-web SPA is served by the lite-server (Hono) in production on port
// 23332. In development we run Vite on 5173 and proxy /api to the dev server
// (default 23432) so the frontend can always call same-origin `/api/public/*`.
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(rootDir, "src") },
      {
        find: /^@peri\/ui$/,
        replacement: path.join(periStudioRoot, "packages/ui/src"),
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
  server: {
    port: 5173,
    fs: {
      allow: [rootDir, periStudioRoot],
    },
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.LITE_SERVER_PORT ?? "23432"}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
