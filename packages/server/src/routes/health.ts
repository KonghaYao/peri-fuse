import { API_COMPAT_VERSION } from "@peri-fuse/shared";
import { Hono } from "hono";
import type { LiteServerEnv } from "../auth";

const app = new Hono<LiteServerEnv>();

app.get("/api/public/health", (c) => c.json({ status: "OK", version: API_COMPAT_VERSION }));
app.get("/api/public/ready", (c) => c.json({ status: "OK" }));

export default app;
