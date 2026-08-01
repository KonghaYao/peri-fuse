import { defineConfig } from "drizzle-kit";

// Drizzle config for the Peri-Fuse metadata database (langfuse.db).
// `drizzle-kit generate` produces the committed CREATE TABLE SQL under ./drizzle,
// which is applied at runtime by src/db/client.ts#ensureSchema (no prisma needed).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  casing: "camelCase",
});
