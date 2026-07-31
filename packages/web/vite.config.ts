import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The lite-web SPA is served by the lite-server (Hono) in production on port
// 23332. In development we run Vite on 5173 and proxy /api to the lite-server
// so the frontend can always call same-origin `/api/public/*` endpoints.
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
        target: "http://localhost:23332",
        changeOrigin: true,
      },
      "/gateway-api": {
        target: "http://localhost:4100",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gateway-api/, "/admin"),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
