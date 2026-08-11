import type { Context } from "hono";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { ModelCatalog, ModelEntry } from "../copilot/model-catalog.js";
import { isChatModel } from "../copilot/model-catalog.js";

interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** Non-standard but widely consumed by OpenAI-compatible clients. */
  context_window?: number;
  max_output_tokens?: number;
  capabilities?: {
    streaming: boolean;
    tool_calls: boolean;
    vision: boolean;
    reasoning_effort?: string[];
  };
}

const fromEntry = (entry: ModelEntry, created: number): OpenAIModel => {
  const out: OpenAIModel = {
    id: entry.id,
    object: "model",
    created,
    owned_by: entry.vendor ?? "github-copilot",
    capabilities: {
      streaming: entry.supportsStreaming,
      tool_calls: entry.supportsToolCalls,
      vision: entry.supportsVision,
    },
  };
  if (entry.maxContextWindowTokens) {
    out.context_window = entry.maxContextWindowTokens;
  }
  if (entry.maxOutputTokens) out.max_output_tokens = entry.maxOutputTokens;
  if (entry.reasoningEfforts.length > 0 && out.capabilities) {
    out.capabilities.reasoning_effort = entry.reasoningEfforts;
  }
  return out;
};

const fromId = (id: string, created: number): OpenAIModel => ({
  id,
  object: "model",
  created,
  owned_by: "github-copilot",
});

export const modelsRoute =
  (cfg: Config, catalog: ModelCatalog, log: Logger) =>
  async (c: Context) => {
    const created = Math.floor(Date.now() / 1000);

    let entries: Map<string, ModelEntry> | null = null;
    try {
      entries = await catalog.get();
    } catch (err) {
      log.warn("model catalog unavailable:", (err as Error).message);
    }

    // When discovery succeeds the live catalog is authoritative. Merging the
    // static fallback back in would resurrect retired models (which then 400
    // upstream), so the fallback is used only when discovery yields nothing.
    if (entries && entries.size > 0) {
      const models = [...entries.values()]
        .filter((e) => cfg.includeNonChatModels || isChatModel(e))
        .map((e) => fromEntry(e, created));
      return c.json({ object: "list", data: models });
    }

    log.debug("serving static fallback model list");
    return c.json({
      object: "list",
      data: cfg.modelList.map((id) => fromId(id, created)),
    });
  };
