/**
 * GET /v1/models — List available models (OpenAI-compatible).
 */
import { Hono } from "hono";
import type { GatewayEnv } from "../../app.js";
import { listModels } from "../../router/model-resolver.js";

const models = new Hono<GatewayEnv>();

models.get("/v1/models", async (c) => {
  const modelNames = await listModels();

  return c.json({
    object: "list",
    data: modelNames.map((name) => ({
      id: name,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "peri-gateway",
    })),
  });
});

export default models;
