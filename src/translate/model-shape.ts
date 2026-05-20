import type { Config } from "../config.js";

/**
 * Apply per-model upstream-shaping rules that aren't covered by the
 * generic sanitizer.
 *
 * Currently: rename `max_tokens` → `max_completion_tokens` for models in
 * `cfg.maxCompletionTokensModels`. (gpt-5.4 and similar reasoning-style
 * models reject `max_tokens`.)
 *
 * Returns a new object only when shaping was applied.
 */
export const applyModelShape = (
  body: Record<string, unknown>,
  cfg: Config,
): Record<string, unknown> => {
  const model = typeof body.model === "string" ? (body.model as string) : "";
  if (!model) return body;

  const needsMaxCompletionTokens = cfg.maxCompletionTokensModels.some(
    (m) => m === model,
  );

  if (
    needsMaxCompletionTokens &&
    "max_tokens" in body &&
    !("max_completion_tokens" in body)
  ) {
    const { max_tokens, ...rest } = body;
    return { ...rest, max_completion_tokens: max_tokens };
  }

  return body;
};

export const isResponsesOnlyModel = (
  model: string | undefined,
  cfg: Config,
): boolean => {
  if (!model) return false;
  return cfg.responsesOnlyModels.includes(model);
};
