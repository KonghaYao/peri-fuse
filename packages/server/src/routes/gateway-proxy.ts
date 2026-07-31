/**
 * Gateway admin routes — mounted directly from the gateway package.
 * No HTTP proxy, no separate port. The gateway admin router is imported
 * and mounted at /api/gateway/* (same trust model as /api/manage/*).
 */
import { createGatewayAdminRouter } from "@peri/gateway/src/admin-router";
import { Hono } from "hono";

const gatewayAdmin = new Hono();
gatewayAdmin.route("/api/gateway", createGatewayAdminRouter());

export default gatewayAdmin;
