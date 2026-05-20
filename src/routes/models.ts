import type { Context } from "hono";
import type { Config } from "../config.js";

export const modelsRoute = (cfg: Config) => (c: Context) => {
  const created = Math.floor(Date.now() / 1000);
  return c.json({
    object: "list",
    data: cfg.modelList.map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "github-copilot",
    })),
  });
};
