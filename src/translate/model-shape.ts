import type { Config } from "../config.js";
import type { ModelCatalog, ModelEntry } from "../copilot/model-catalog.js";
import { isResponsesOnlyEntry } from "../copilot/model-catalog.js";

/**
 * Apply per-model upstream-shaping rules that aren't covered by the
 * generic sanitizer.
 *
 * - Renames `max_tokens` → `max_completion_tokens` for models that reject the
 *   former (`gpt-5.4` at time of writing).
 * - Drops `reasoning_effort` when the target model doesn't advertise support,
 *   and clamps it to an advertised value when it does.
 *
 * Returns a new object only when shaping was applied.
 */
export const applyModelShape = (
  body: Record<string, unknown>,
  cfg: Config,
  entry?: ModelEntry,
): Record<string, unknown> => {
  const model = typeof body.model === "string" ? (body.model as string) : "";
  if (!model) return body;

  let out = body;
  const clone = (): Record<string, unknown> => {
    if (out === body) out = { ...body };
    return out;
  };

  const needsMaxCompletionTokens = cfg.maxCompletionTokensModels.some(
    (m) => m === model,
  );

  if (
    needsMaxCompletionTokens &&
    "max_tokens" in out &&
    !("max_completion_tokens" in out)
  ) {
    const next = clone();
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
  }

  if ("reasoning_effort" in out) {
    const shaped = shapeReasoningEffort(out.reasoning_effort, cfg, entry);
    if (shaped === undefined) {
      delete clone().reasoning_effort;
    } else if (shaped !== out.reasoning_effort) {
      clone().reasoning_effort = shaped;
    }
  }

  return out;
};

/** Advertised reasoning levels, weakest → strongest. */
const REASONING_LADDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Normalize the two reasoning spellings into a single `reasoning_effort`.
 *
 * Chat Completions uses `reasoning_effort: "high"`, the Responses API uses
 * `reasoning: { effort: "high" }`. Clients send either; collapsing them here
 * means the chat path and the responses bridge both see one canonical field.
 */
export const normalizeReasoning = (
  body: Record<string, unknown>,
): Record<string, unknown> => {
  if (!("reasoning" in body)) return body;

  const { reasoning, ...rest } = body;
  const effort =
    reasoning && typeof reasoning === "object"
      ? (reasoning as { effort?: unknown }).effort
      : undefined;

  if (typeof effort === "string" && effort && !("reasoning_effort" in rest)) {
    return { ...rest, reasoning_effort: effort };
  }
  return rest;
};

/**
 * Resolve the `reasoning_effort` value to send upstream.
 *
 * Returns `undefined` when the parameter should be dropped: passthrough
 * disabled, or the catalog says this model doesn't support reasoning. When the
 * catalog is unavailable the value is forwarded unchanged — upstream is the
 * final authority, and dropping it would silently ignore the client.
 */
export const shapeReasoningEffort = (
  value: unknown,
  cfg: Config,
  entry?: ModelEntry,
): string | undefined => {
  if (!cfg.reasoningPassthrough) return undefined;
  if (typeof value !== "string" || !value) return undefined;
  if (!entry) return value;
  if (entry.reasoningEfforts.length === 0) return undefined;
  if (entry.reasoningEfforts.includes(value)) return value;

  // Client asked for a level this model doesn't publish (e.g. "xhigh" on a
  // low/medium/high model). Clamp to the nearest advertised level rather than
  // letting upstream reject the request.
  const want = REASONING_LADDER.indexOf(value);
  if (want === -1) {
    return entry.reasoningEfforts[entry.reasoningEfforts.length - 1];
  }

  let best = entry.reasoningEfforts[0] as string;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of entry.reasoningEfforts) {
    const idx = REASONING_LADDER.indexOf(candidate);
    if (idx === -1) continue;
    const dist = Math.abs(idx - want);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
};

/**
 * Whether a model must be dispatched to `/responses` instead of
 * `/chat/completions`.
 *
 * Prefers the live upstream catalog (`supported_endpoints`) so newly added and
 * retired models route correctly without a config change. Falls back to the
 * static `responsesOnlyModels` list when the catalog is unavailable.
 */
export const isResponsesOnlyModel = (
  model: string | undefined,
  cfg: Config,
  entry?: ModelEntry,
): boolean => {
  if (!model) return false;
  if (entry) return isResponsesOnlyEntry(entry);
  return cfg.responsesOnlyModels.includes(model);
};

/** Look up a catalog entry, tolerating a missing or failed catalog. */
export const lookupModel = async (
  catalog: ModelCatalog | undefined,
  model: string | undefined,
): Promise<ModelEntry | undefined> => {
  if (!catalog || !model) return undefined;
  try {
    return await catalog.entry(model);
  } catch {
    return undefined;
  }
};
