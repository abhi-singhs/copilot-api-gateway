/**
 * Centralized request sanitizer.
 *
 * GitHub Copilot's `/chat/completions` edge rejects (or silently mishandles)
 * a handful of Anthropic-specific and OpenAI-extension fields. This module
 * walks an OpenAI-shaped request body and removes them before the request
 * goes upstream, optionally logging each removal.
 *
 * The drop list is intentionally conservative: anything Copilot accepts
 * passes through untouched.
 */

import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Drop sets — defaults
// ---------------------------------------------------------------------------

/**
 * Top-level request fields that Copilot rejects or that are Anthropic-only.
 * `system` is **not** in this set because the OpenAI route forwards
 * everything-as-is and a top-level `system` string is converted to a
 * `messages[0].role="system"` entry instead.
 */
export const DEFAULT_DROPPED_TOP_LEVEL: ReadonlySet<string> = new Set([
  "anthropic_version",
  "anthropic_beta",
  "thinking",
  "cache_control",
  "metadata",
  "service_tier",
  "extra_headers",
  "extra_body",
  "container",
  "mcp_servers",
  "prompt_cache_key",
  "safety_identifier",
  // NOTE: `reasoning` / `reasoning_effort` are deliberately NOT dropped.
  // Copilot accepts `reasoning_effort` on `/chat/completions` and
  // `reasoning: { effort }` on `/responses`, and most current models
  // advertise `capabilities.supports.reasoning_effort`. Per-model handling
  // lives in `model-shape.ts`, which drops the field only for models that
  // don't advertise support.
  "modalities",
  "audio",
  "prediction",
  "store",
  "web_search_options",
]);

/**
 * Keys that should be stripped from content blocks and tool definitions
 * (recursively).
 */
export const DEFAULT_DROPPED_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "cache_control",
]);

/**
 * Content-block `type` values that should be removed entirely from
 * `messages[*].content[]`. Anthropic-only block types Copilot doesn't
 * understand.
 */
export const DEFAULT_DROPPED_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "thinking",
  "redacted_thinking",
  "document",
  "server_tool_use",
  "web_search_tool_result",
  "code_execution_tool_result",
  "container_upload",
]);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface SanitizeOptions {
  /** Top-level keys to delete from the request body. */
  dropTopLevel: ReadonlySet<string>;
  /** Keys to delete from every content-block and tool object. */
  dropContentKeys: ReadonlySet<string>;
  /** Content-block `type` values to remove from `messages[*].content[]`. */
  dropBlockTypes: ReadonlySet<string>;
  /** Optional sink for "dropped X at path" notifications. */
  onDrop?: (path: string, reason: string) => void;
}

export interface SanitizeResult {
  body: Record<string, unknown>;
  dropped: Array<{ path: string; reason: string }>;
}

export const buildSanitizeOptions = (
  extraTopLevel: readonly string[] = [],
  log?: Logger,
): SanitizeOptions => {
  const topLevel = new Set<string>(DEFAULT_DROPPED_TOP_LEVEL);
  for (const k of extraTopLevel) {
    const trimmed = k.trim();
    if (trimmed) topLevel.add(trimmed);
  }
  return {
    dropTopLevel: topLevel,
    dropContentKeys: DEFAULT_DROPPED_CONTENT_KEYS,
    dropBlockTypes: DEFAULT_DROPPED_BLOCK_TYPES,
    onDrop: log
      ? (path, reason) => log.debug(`sanitizer: dropped ${path} (${reason})`)
      : undefined,
  };
};

/**
 * Strip dropped-keys from a generic object (one level deep, non-recursive
 * into arrays). Returns a new object only if anything was removed.
 */
const stripKeys = (
  obj: Record<string, unknown>,
  keys: ReadonlySet<string>,
  basePath: string,
  onDrop?: SanitizeOptions["onDrop"],
): Record<string, unknown> => {
  let touched = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keys.has(k)) {
      touched = true;
      onDrop?.(`${basePath}.${k}`, "dropped key");
      continue;
    }
    out[k] = v;
  }
  return touched ? out : obj;
};

const sanitizeContentBlock = (
  block: unknown,
  path: string,
  opts: SanitizeOptions,
): unknown | undefined => {
  if (block === null || block === undefined) return block;
  if (typeof block !== "object") return block;

  const obj = block as Record<string, unknown>;
  const t = typeof obj.type === "string" ? (obj.type as string) : undefined;
  if (t && opts.dropBlockTypes.has(t)) {
    opts.onDrop?.(path, `dropped content block of type "${t}"`);
    return undefined;
  }

  return stripKeys(obj, opts.dropContentKeys, path, opts.onDrop);
};

const sanitizeMessage = (
  msg: unknown,
  path: string,
  opts: SanitizeOptions,
): unknown => {
  if (msg === null || typeof msg !== "object") return msg;
  const m = { ...(msg as Record<string, unknown>) };

  // Strip Anthropic-only keys from the message itself
  for (const k of opts.dropContentKeys) {
    if (k in m) {
      opts.onDrop?.(`${path}.${k}`, "dropped key");
      delete m[k];
    }
  }

  const c = m.content;
  if (Array.isArray(c)) {
    const cleaned: unknown[] = [];
    c.forEach((blk, i) => {
      const out = sanitizeContentBlock(blk, `${path}.content[${i}]`, opts);
      if (out !== undefined) cleaned.push(out);
    });
    m.content = cleaned;
  }
  return m;
};

const sanitizeTool = (
  tool: unknown,
  path: string,
  opts: SanitizeOptions,
): unknown => {
  if (tool === null || typeof tool !== "object") return tool;
  let t = { ...(tool as Record<string, unknown>) };
  t = stripKeys(t, opts.dropContentKeys, path, opts.onDrop);
  // OpenAI shape: {type:"function", function:{...}}; clean inside too.
  const fn = t.function;
  if (fn && typeof fn === "object") {
    t.function = stripKeys(
      fn as Record<string, unknown>,
      opts.dropContentKeys,
      `${path}.function`,
      opts.onDrop,
    );
  }
  return t;
};

/**
 * Sanitize an OpenAI-shaped request body for upstream forwarding.
 *
 * Returns a new object (the input is not mutated) along with a list of
 * everything that was removed — useful for tests and debug logging.
 */
export const sanitizeRequest = (
  payload: Record<string, unknown>,
  opts: SanitizeOptions,
): SanitizeResult => {
  const dropped: Array<{ path: string; reason: string }> = [];
  const sink = (path: string, reason: string): void => {
    dropped.push({ path, reason });
    opts.onDrop?.(path, reason);
  };
  const innerOpts: SanitizeOptions = { ...opts, onDrop: sink };

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (innerOpts.dropTopLevel.has(k)) {
      sink(k, "dropped top-level field");
      continue;
    }
    out[k] = v;
  }

  if (Array.isArray(out.messages)) {
    out.messages = (out.messages as unknown[]).map((m, i) =>
      sanitizeMessage(m, `messages[${i}]`, innerOpts),
    );
  }

  if (Array.isArray(out.tools)) {
    out.tools = (out.tools as unknown[]).map((t, i) =>
      sanitizeTool(t, `tools[${i}]`, innerOpts),
    );
  }

  // OpenAI "system" message in the messages array is fine; a *top-level*
  // `system: string` is Anthropic-style. Convert it into a leading system
  // message rather than dropping silently — that's friendlier for OpenAI
  // clients that mis-send it.
  if (typeof payload.system === "string" || Array.isArray(payload.system)) {
    const systemText =
      typeof payload.system === "string"
        ? payload.system
        : (payload.system as Array<{ type?: string; text?: string }>)
            .filter((b) => b && b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n\n");
    if (systemText) {
      const msgs = Array.isArray(out.messages) ? out.messages : [];
      out.messages = [{ role: "system", content: systemText }, ...msgs];
      sink("system", "converted top-level Anthropic-style system into messages[0]");
    } else {
      sink("system", "dropped empty top-level system");
    }
    // either way, ensure the raw top-level field is removed
    delete out.system;
  }

  return { body: out, dropped };
};
