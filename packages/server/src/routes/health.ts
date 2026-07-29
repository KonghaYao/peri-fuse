import { Hono } from "hono";
import type { LiteServerEnv } from "../auth";

const app = new Hono<LiteServerEnv>();

app.get("/api/public/health", (c) => c.json({ status: "OK" }));
app.get("/api/public/ready", (c) => c.json({ status: "OK" }));

export default app;
