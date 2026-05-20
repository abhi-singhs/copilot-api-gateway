import type { Context } from "hono";
import type { Config } from "../config.js";
import type { CopilotClient } from "../copilot/client.js";
import type { Logger } from "../logger.js";

/**
 * Native passthrough for the OpenAI Responses API (`POST /v1/responses`).
 * Used by callers who already speak that API and want to target a Copilot
 * responses-only model directly.
 */
export const responsesRoute =
  (_cfg: Config, client: CopilotClient, log: Logger) =>
  async (c: Context) => {
    let payload: Record<string, unknown>;
    try {
      payload = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(
        {
          error: {
            message: "Invalid JSON body",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    log.debug("responses passthrough", {
      model: payload.model,
      stream: payload.stream === true,
    });

    let upstream: Response;
    try {
      upstream = await client.responses(payload);
    } catch (err) {
      log.error("upstream /responses request failed:", (err as Error).message);
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
      log.warn(`upstream /responses error ${upstream.status}: ${text.slice(0, 500)}`);
      return new Response(text, {
        status: upstream.status,
        headers: {
          "content-type":
            upstream.headers.get("content-type") ?? "application/json",
        },
      });
    }

    if (payload.stream === true && upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }

    const json = await upstream.json();
    return c.json(json);
  };
