/**
 * Mock OpenAI-compatible LLM server for testing PeriGateway.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const app = new Hono();

app.post("/chat/completions", async (c) => {
  const body = await c.req.json();
  const isStream = body.stream ?? false;

  if (isStream) {
    return streamSSE(c, async (stream) => {
      const words = ["Hello", " from", " mock", " LLM", " server", "!"];
      for (let i = 0; i < words.length; i++) {
        await stream.writeSSE({
          data: JSON.stringify({
            id: "chatcmpl-mock-123",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{ index: 0, delta: { content: words[i] }, finish_reason: null }],
          }),
        });
        await new Promise((r) => setTimeout(r, 50));
      }
      // Final chunk with usage
      await stream.writeSSE({
        data: JSON.stringify({
          id: "chatcmpl-mock-123",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
        }),
      });
      await stream.writeSSE({ data: "[DONE]" });
    });
  }

  // Non-streaming response
  return c.json({
    id: "chatcmpl-mock-123",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello from mock LLM server!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
  });
});

serve({ fetch: app.fetch, port: 9999 }, (info) => {
  console.log(`[mock-llm] Listening on http://localhost:${info.port}`);
});
