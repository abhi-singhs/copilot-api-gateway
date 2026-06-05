import type { Context } from "hono";
import type { Config } from "../config.js";
import type { CopilotClient } from "../copilot/client.js";
import type { Logger } from "../logger.js";
import {
  translateAnthropicRequest,
  type AnthropicRequest,
} from "../translate/anthropic-request.js";
import {
  translateNonStreamResponse,
  translateStreamResponse,
} from "../translate/anthropic-response.js";
import { buildSanitizeOptions, sanitizeRequest } from "../translate/sanitize.js";
import { applyModelShape, isResponsesOnlyModel } from "../translate/model-shape.js";
import {
  chatToResponsesRequest,
  responsesStreamToChatStream,
  responsesToChatNonStream,
} from "../translate/responses.js";
import { logBody, tapStream } from "../log-tap.js";

const shouldTryAlternateEndpoint = (status: number, text: string): boolean => {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  const lower = text.toLowerCase();
  return /model|unsupported|not supported|unknown|\/responses|chat\/completions/.test(lower);
};

export const anthropicMessagesRoute =
  (cfg: Config, client: CopilotClient, log: Logger) => {
  const sanitizeOpts = buildSanitizeOptions(cfg.dropParamsExtra, log);

  return async (c: Context) => {
    let payload: AnthropicRequest;
    try {
      payload = (await c.req.json()) as AnthropicRequest;
    } catch {
      return c.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "Invalid JSON body" },
        },
        400,
      );
    }

    if (cfg.logBodies) logBody(log, "→ CLIENT POST /v1/messages", payload);

    const { body: translatedBody, stream } = translateAnthropicRequest(payload);
    // Defense in depth: translateAnthropicRequest builds a fresh body and
    // therefore already excludes Anthropic-only fields, but we run the
    // sanitizer once more so a future field that sneaks through the
    // translator (or a custom drop list from COPILOT_API_DROP_PARAMS_EXTRA)
    // is still caught.
    const sanitizedChat = cfg.dropParams
      ? sanitizeRequest(translatedBody, sanitizeOpts).body
      : translatedBody;

    const model = typeof sanitizedChat.model === "string" ? sanitizedChat.model : "";
    const responsesBody = chatToResponsesRequest(sanitizedChat);
    const chatBody = applyModelShape(sanitizedChat, cfg);
    const tryResponsesFirst = isResponsesOnlyModel(model, cfg);
    const attemptOrder = tryResponsesFirst ? [true, false] : [false, true];

    let upstream: Response | null = null;
    let useResponses = tryResponsesFirst;
    for (let i = 0; i < attemptOrder.length; i += 1) {
      useResponses = attemptOrder[i] as boolean;
      const upstreamBody = useResponses ? responsesBody : chatBody;

      log.debug(
        useResponses
          ? "anthropic /v1/messages → responses bridge"
          : "anthropic /v1/messages",
        {
          model,
          stream,
          route: useResponses ? "/responses" : "/chat/completions",
          msgs: Array.isArray(sanitizedChat.messages) ? sanitizedChat.messages.length : 0,
          attempt: i + 1,
        },
      );

      try {
        upstream = useResponses
          ? await client.responses(upstreamBody)
          : await client.chatCompletions(upstreamBody);
      } catch (err) {
        if (i === 0) {
          log.warn(
            "first upstream route failed before response; trying alternate route",
            { model, attemptedRoute: useResponses ? "/responses" : "/chat/completions" },
          );
          continue;
        }
        log.error("upstream request failed:", (err as Error).message);
        return c.json(
          {
            type: "error",
            error: {
              type: "api_error",
              message: `Upstream request failed: ${(err as Error).message}`,
            },
          },
          502,
        );
      }

      if (upstream.ok || upstream.status < 400) break;

      const text = await upstream.text();
      const canRetry = i === 0 && shouldTryAlternateEndpoint(upstream.status, text);
      if (canRetry) {
        log.info("retrying with alternate upstream endpoint for model", {
          model,
          status: upstream.status,
          attemptedRoute: useResponses ? "/responses" : "/chat/completions",
        });
        continue;
      }

      log.warn(`upstream error ${upstream.status}: ${text.slice(0, 500)}`);
      // Wrap upstream error in Anthropic error envelope where possible.
      let upstreamErr: unknown;
      try { upstreamErr = JSON.parse(text); } catch { upstreamErr = { message: text }; }
      const errMsg =
        (upstreamErr as { error?: { message?: string }; message?: string })?.error
          ?.message ??
        (upstreamErr as { message?: string })?.message ??
        text.slice(0, 500);
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: upstream.status === 401 ? "authentication_error"
              : upstream.status === 429 ? "rate_limit_error"
              : upstream.status >= 500 ? "api_error"
              : "invalid_request_error",
            message: errMsg,
          },
        }),
        {
          status: upstream.status,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (!upstream) {
      return c.json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: "Upstream request failed on all route attempts",
          },
        },
        502,
      );
    }

    if (stream && upstream.body) {
      // For responses-only models the upstream is a Responses SSE stream;
      // bridge it back through the chat-completions SSE shape that
      // translateStreamResponse already knows how to consume.
      const intermediate = useResponses
        ? responsesStreamToChatStream(upstream.body, model)
        : upstream.body;
      const translated = translateStreamResponse(intermediate, payload.model);
      return new Response(
        tapStream(translated, log, "← CLIENT SSE /v1/messages", cfg.logBodies),
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

    const json = (await upstream.json()) as Record<string, unknown>;
    const chatShape = useResponses ? responsesToChatNonStream(json) : json;
    const out = translateNonStreamResponse(chatShape, payload.model);
    if (cfg.logBodies) logBody(log, "← CLIENT /v1/messages", out);
    return c.json(out);
  };
};