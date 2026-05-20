import type { Context, Next } from "hono";
import type { Config } from "../config.js";

export const masterKeyMiddleware = (cfg: Config) =>
  async (c: Context, next: Next) => {
    if (!cfg.requireAuth) return next();

    const hdr =
      c.req.header("authorization") ??
      c.req.header("Authorization") ??
      "";
    const apiKey = c.req.header("x-api-key") ?? c.req.header("X-Api-Key");

    let provided: string | undefined;
    if (hdr.toLowerCase().startsWith("bearer ")) {
      provided = hdr.slice(7).trim();
    } else if (apiKey) {
      provided = apiKey.trim();
    }

    if (!provided || provided !== cfg.masterKey) {
      return c.json(
        {
          error: {
            message: "Invalid or missing API key.",
            type: "authentication_error",
            code: "invalid_api_key",
          },
        },
        401,
      );
    }
    return next();
  };
