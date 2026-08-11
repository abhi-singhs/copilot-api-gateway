/**
 * Cached view of the upstream Copilot model catalog.
 *
 * `GET /models` publishes, per model, which endpoints it can be called on
 * (`supported_endpoints`), what it supports (`capabilities.supports`) and what
 * kind of model it is (`capabilities.type`). Deriving behaviour from that
 * metadata keeps the gateway correct as Copilot adds and retires models,
 * instead of relying on hand-maintained constants that silently go stale.
 *
 * Everything here degrades gracefully: if the catalog can't be fetched, callers
 * fall back to the static config lists.
 */

import type { Config } from "../config.js";
import type { CopilotClient } from "./client.js";
import type { Logger } from "../logger.js";

export interface ModelVisionLimits {
  max_prompt_images?: number;
  supported_media_types?: string[];
}

export interface ModelEntry {
  id: string;
  name?: string;
  vendor?: string;
  /** `chat`, `embeddings`, `completion`, ... */
  type?: string;
  /** e.g. ["/responses", "/chat/completions", "ws:/responses"] */
  supportedEndpoints: string[];
  /** Advertised `reasoning_effort` values, empty when unsupported. */
  reasoningEfforts: string[];
  maxContextWindowTokens?: number;
  maxOutputTokens?: number;
  maxPromptTokens?: number;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsVision: boolean;
  modelPickerEnabled: boolean;
  /** Raw entry, for passthrough of fields we don't model explicitly. */
  raw: Record<string, unknown>;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export const parseModelEntry = (raw: unknown): ModelEntry | null => {
  const m = asRecord(raw);
  const id = typeof m.id === "string" ? m.id : "";
  if (!id) return null;

  const caps = asRecord(m.capabilities);
  const supports = asRecord(caps.supports);
  const limits = asRecord(caps.limits);

  return {
    id,
    name: typeof m.name === "string" ? m.name : undefined,
    vendor: typeof m.vendor === "string" ? m.vendor : undefined,
    type: typeof caps.type === "string" ? caps.type : undefined,
    supportedEndpoints: asStringArray(m.supported_endpoints),
    reasoningEfforts: asStringArray(supports.reasoning_effort),
    maxContextWindowTokens: asNumber(limits.max_context_window_tokens),
    maxOutputTokens: asNumber(limits.max_output_tokens),
    maxPromptTokens: asNumber(limits.max_prompt_tokens),
    supportsStreaming: supports.streaming === true,
    supportsToolCalls: supports.tool_calls === true,
    supportsVision: supports.vision === true,
    modelPickerEnabled: m.model_picker_enabled === true,
    raw: m,
  };
};

export const parseModelCatalog = (json: unknown): Map<string, ModelEntry> => {
  const data = asRecord(json).data;
  const out = new Map<string, ModelEntry>();
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    const entry = parseModelEntry(item);
    // First entry wins: upstream lists preferred aliases before legacy ones.
    if (entry && !out.has(entry.id)) out.set(entry.id, entry);
  }
  return out;
};

/**
 * A model is chat-callable unless upstream explicitly says otherwise.
 * Legacy models omit `capabilities.type`, so absence means "assume chat".
 */
export const isChatModel = (entry: ModelEntry): boolean =>
  entry.type === undefined || entry.type === "chat";

/**
 * True when upstream exposes the model on `/responses` but NOT on
 * `/chat/completions`. Models with no `supported_endpoints` at all are legacy
 * chat-completions models, so they are not responses-only.
 */
export const isResponsesOnlyEntry = (entry: ModelEntry): boolean => {
  if (entry.supportedEndpoints.length === 0) return false;
  const hasChat = entry.supportedEndpoints.includes("/chat/completions");
  const hasResponses = entry.supportedEndpoints.some(
    (e) => e === "/responses" || e === "ws:/responses",
  );
  return hasResponses && !hasChat;
};

export class ModelCatalog {
  private entries: Map<string, ModelEntry> | null = null;
  private fetchedAt = 0;
  private failedAt = 0;
  private inflight: Promise<Map<string, ModelEntry> | null> | null = null;

  constructor(
    private cfg: Config,
    private client: CopilotClient,
    private log: Logger,
  ) {}

  private isFresh(): boolean {
    return (
      this.entries !== null &&
      Date.now() - this.fetchedAt < Math.max(0, this.cfg.modelsCacheTtlMs)
    );
  }

  /**
   * True while a recent failure is still being backed off.
   *
   * Without this, a degraded upstream `/models` would make every proxied chat
   * request re-attempt discovery (and block on it), because a failed refresh
   * never advances `fetchedAt`.
   */
  private inFailureBackoff(): boolean {
    return (
      this.failedAt > 0 &&
      Date.now() - this.failedAt < Math.max(0, this.cfg.modelsFailureBackoffMs)
    );
  }

  /** Cached catalog, or `null` when discovery is disabled or upstream failed. */
  async get(): Promise<Map<string, ModelEntry> | null> {
    if (!this.cfg.modelDiscovery) return null;
    if (this.isFresh()) return this.entries;
    // Serve whatever we have (possibly nothing) rather than retrying a known
    // bad upstream on every request.
    if (this.inFailureBackoff()) return this.entries;
    if (this.inflight) return this.inflight;

    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<Map<string, ModelEntry> | null> {
    try {
      const res = await this.client.models();
      if (!res.ok) {
        const text = await res.text();
        this.log.warn(
          `upstream /models error ${res.status}: ${text.slice(0, 300)}`,
        );
        this.failedAt = Date.now();
        return this.entries;
      }
      const parsed = parseModelCatalog(await res.json());
      if (parsed.size === 0) {
        this.log.warn("upstream /models returned no usable entries");
        this.failedAt = Date.now();
        return this.entries;
      }
      this.entries = parsed;
      this.fetchedAt = Date.now();
      this.failedAt = 0;
      this.log.debug(`model catalog refreshed: ${parsed.size} models`);
      return this.entries;
    } catch (err) {
      this.log.warn("upstream /models fetch failed:", (err as Error).message);
      this.failedAt = Date.now();
      // Serve the previous snapshot rather than losing routing information.
      return this.entries;
    }
  }

  /** Cached entry without triggering a fetch. */
  peek(model: string): ModelEntry | undefined {
    return this.entries?.get(model);
  }

  async entry(model: string): Promise<ModelEntry | undefined> {
    const all = await this.get();
    return all?.get(model);
  }

  invalidate(): void {
    this.entries = null;
    this.fetchedAt = 0;
    this.failedAt = 0;
  }
}
