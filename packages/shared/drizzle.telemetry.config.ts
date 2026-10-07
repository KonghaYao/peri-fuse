import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/telemetry/index.ts",
  out: "./telemetry-drizzle",
});
