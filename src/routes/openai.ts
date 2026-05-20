import type { Context } from "hono";
import type { Config } from "../config.js";
import type { CopilotClient } from "../copilot/client.js";
import type { Logger } from "../logger.js";
import { buildSanitizeOptions, sanitizeRequest } from "../translate/sanitize.js";
import { applyModelShape, isResponsesOnlyModel } from "../translate/model-shape.js";
import {
  chatToResponsesRequest,
  responsesStreamToChatStream,
  responsesToChatNonStream,
} from "../translate/responses.js";
import { logBody, tapStream } from "../log-tap.js";

export const openaiChatRoute =
  (cfg: Config, client: CopilotClient, log: Logger) => {
    const sanitizeOpts = buildSanitizeOptions(cfg.dropParamsExtra, log);

    return async (c: Context) => {
      let payload: Record<string, unknown>;
      try {
        payload = (await c.req.json()) as Record<string, unknown>;
      } catch {
        return c.json(
          { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
          400,
        );
      }

      if (cfg.logBodies) logBody(log, "→ CLIENT POST /v1/chat/completions", payload);

      const sanitized = cfg.dropParams
        ? sanitizeRequest(payload, sanitizeOpts).body
        : payload;

      const model = typeof sanitized.model === "string" ? sanitized.model : "";
      const stream = sanitized.stream === true;
      const useResponses = isResponsesOnlyModel(model, cfg);

      const body = useResponses
        ? chatToResponsesRequest(sanitized)
        : applyModelShape(sanitized, cfg);

      log.debug(
        useResponses
          ? "openai chat → responses bridge"
          : "openai chat completion",
        { model, stream, route: useResponses ? "/responses" : "/chat/completions" },
      );

      let upstream: Response;
      try {
        upstream = useResponses
          ? await client.responses(body)
          : await client.chatCompletions(body);
      } catch (err) {
        log.error("upstream request failed:", (err as Error).message);
        return c.json(
          {
            error: {
              message: `Upstream request failed: ${(err as Error).message}`,
              type: "api_error",
            },
          },
          502,
        );
      }

      if (!upstream.ok && upstream.status >= 400) {
        const text = await upstream.text();
        log.warn(`upstream error ${upstream.status}: ${text.slice(0, 500)}`);
        return new Response(text, {
          status: upstream.status,
          headers: {
            "content-type":
              upstream.headers.get("content-type") ?? "application/json",
          },
        });
      }

      if (stream && upstream.body) {
        const outBody = useResponses
          ? responsesStreamToChatStream(upstream.body, model)
          : upstream.body;
        return new Response(
          tapStream(outBody, log, "← CLIENT SSE /v1/chat/completions", cfg.logBodies),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
              "x-accel-buffering": "no",
            },
          },
        );
      }

      const json = await upstream.json();
      const outJson = useResponses
        ? responsesToChatNonStream(json as Record<string, unknown>)
        : json;
      if (cfg.logBodies) logBody(log, "← CLIENT /v1/chat/completions", outJson);
      return c.json(outJson);
    };
  };
