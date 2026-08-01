/**
 * Health check route for PeriGateway.
 */
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { getDb } from "../db.js";

const health = new Hono();

health.get("/health", async (c) => {
  try {
    // Verify DB connectivity
    await getDb().get(sql`SELECT 1`);
    return c.json({
      status: "ok",
      service: "peri-gateway",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return c.json(
      {
        status: "error",
        service: "peri-gateway",
        error: err instanceof Error ? err.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
});

export default health;
