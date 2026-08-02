/**
 * Gateway admin routes — mounted directly from the gateway package.
 * No HTTP proxy, no separate port. The gateway admin router is imported
 * and mounted at /api/gateway/*. Auth (unifiedAuth) is applied inside
 * createGatewayAdminRouter(), which resolves the project-scoped projectId
 * from the Basic/Bearer credentials sent by the web UI.
 */
import { createGatewayAdminRouter } from "@peri/gateway/admin-router";
import { Hono } from "hono";

const gatewayAdmin = new Hono();
gatewayAdmin.route("/api/gateway", createGatewayAdminRouter() as unknown as Hono);

export default gatewayAdmin;
