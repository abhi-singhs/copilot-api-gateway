import type { Context } from "hono";
import type { Config } from "../config.js";
import type { CopilotClient } from "../copilot/client.js";
import type { Logger } from "../logger.js";

const toModelObjects = (ids: string[]) => {
  const created = Math.floor(Date.now() / 1000);
  return ids.map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "github-copilot",
    }));
};

const parseUpstreamModelIds = (json: unknown): string[] => {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return Array.from(new Set(ids));
};

export const modelsRoute =
  (cfg: Config, client: CopilotClient, log: Logger) => {
    let cachedIds: string[] | null = null;
    let cacheUntil = 0;

    return async (c: Context) => {
      const now = Date.now();
      if (
        cfg.modelDiscovery &&
        cachedIds &&
        now < cacheUntil
      ) {
        return c.json({ object: "list", data: toModelObjects(cachedIds) });
      }

      let discoveredIds: string[] = [];
      if (cfg.modelDiscovery) {
        try {
          const upstream = await client.models();
          if (upstream.ok) {
            const payload = await upstream.json();
            discoveredIds = parseUpstreamModelIds(payload);
          } else {
            const text = await upstream.text();
            log.warn(`upstream /models error ${upstream.status}: ${text.slice(0, 300)}`);
          }
        } catch (err) {
          log.warn("upstream /models fetch failed:", (err as Error).message);
        }
      }

      const combined = Array.from(new Set([...discoveredIds, ...cfg.modelList]));
      const outIds = combined.length > 0 ? combined : cfg.modelList;

      if (cfg.modelDiscovery && outIds.length > 0) {
        cachedIds = outIds;
        cacheUntil = now + Math.max(0, cfg.modelsCacheTtlMs);
      }

      return c.json({ object: "list", data: toModelObjects(outIds) });
    };
};
