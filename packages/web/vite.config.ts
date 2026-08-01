import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The lite-web SPA is served by the lite-server (Hono) in production on port
// 23332. In development we run Vite on 5173 and proxy /api to the dev server
// (default 23432) so the frontend can always call same-origin `/api/public/*`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
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
