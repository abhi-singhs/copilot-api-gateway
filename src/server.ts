import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";
import { CopilotTokenManager } from "./copilot/token.js";
import { CopilotClient } from "./copilot/client.js";
import { masterKeyMiddleware } from "./auth/master-key.js";
import { modelsRoute } from "./routes/models.js";
import { openaiChatRoute } from "./routes/openai.js";
import { anthropicMessagesRoute } from "./routes/anthropic.js";
import { responsesRoute } from "./routes/responses.js";

export const createApp = (cfg: Config) => {
  const log = createLogger(cfg.logLevel);
  const tokens = new CopilotTokenManager(cfg, log);
  const client = new CopilotClient(cfg, tokens, log);

  const app = new Hono();

  app.use("*", cors());
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const dur = Date.now() - start;
    log.info(`${c.req.method} ${c.req.path} -> ${c.res.status} ${dur}ms`);
  });

  // Health
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/", (c) =>
    c.json({
      name: "copilot-api-gateway",
      endpoints: [
        "GET  /health",
        "GET  /v1/models",
        "POST /v1/chat/completions",
        "POST /v1/messages",
        "POST /v1/responses",
      ],
    }),
  );

  // Auth-gated routes
  const gate = masterKeyMiddleware(cfg);
  app.use("/v1/*", gate);

  app.get("/v1/models", modelsRoute(cfg, client, log));
  app.post("/v1/chat/completions", openaiChatRoute(cfg, client, log));
  app.post("/v1/messages", anthropicMessagesRoute(cfg, client, log));
  app.post("/v1/responses", responsesRoute(cfg, client, log));

  return { app, log };
};
