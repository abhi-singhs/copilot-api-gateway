import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const HOME = homedir();

const intEnv = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export interface Config {
  host: string;
  port: number;
  masterKey: string;
  requireAuth: boolean;
  tokenDir: string;
  accessTokenFile: string;
  apiKeyFile: string;
  /**
   * Upstream base URL. Used as-is when `copilotApiBaseExplicit` is true;
   * otherwise the token's `endpoints.api` takes precedence and this is the
   * fallback.
   */
  copilotApiBase: string;
  /** True when `COPILOT_API_BASE` was set explicitly. */
  copilotApiBaseExplicit: boolean;
  copilotChatEndpoint: string;
  editorVersion: string;
  editorPluginVersion: string;
  copilotIntegrationId: string;
  userAgent: string;
  githubClientId: string;
  githubDeviceCodeUrl: string;
  githubAccessTokenUrl: string;
  copilotInternalTokenUrl: string;
  requestTimeoutMs: number;
  defaultModel: string;
  smallFastModel: string;
  modelList: string[];
  /**
   * Discover upstream models from Copilot `/models` and expose them from
   * local `/v1/models`.
   */
  modelDiscovery: boolean;
  /** Cache TTL for discovered models, in milliseconds. */
  modelsCacheTtlMs: number;
  /**
   * How long to back off before retrying model discovery after a failure.
   * Prevents a degraded upstream `/models` from being re-hit on every request.
   */
  modelsFailureBackoffMs: number;
  /**
   * Timeout for the `/models` catalog request. Deliberately much shorter than
   * `requestTimeoutMs`: discovery sits on the request hot path, so a hung
   * catalog host must degrade to the static fallback quickly rather than
   * stalling proxied completions.
   */
  modelsTimeoutMs: number;
  /**
   * Models that must be dispatched to the upstream `/responses` endpoint
   * instead of `/chat/completions`. Auto-translated transparently.
   *
   * Fallback only: normally derived from upstream `supported_endpoints`.
   */
  responsesOnlyModels: string[];
  /**
   * Include non-chat models (embeddings, completion) in `/v1/models`.
   * Off by default — the gateway exposes no endpoint that can call them.
   */
  includeNonChatModels: boolean;
  /**
   * Forward `reasoning_effort` upstream for models that advertise support.
   */
  reasoningPassthrough: boolean;
  /**
   * Models that reject `max_tokens` and require `max_completion_tokens`
   * (reasoning / GPT-5.4 series).
   */
  maxCompletionTokensModels: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  /** Log full inbound + upstream request/response bodies. */
  logBodies: boolean;
  // Stripped on the way upstream:
  dropParams: boolean;
  /** Extra top-level keys to strip from requests, in addition to the defaults. */
  dropParamsExtra: string[];
}

export const loadConfig = (): Config => {
  const tokenDir =
    process.env.COPILOT_API_TOKEN_DIR ??
    join(HOME, ".config", "copilot-api-gateway", "github_copilot");

  // Offline fallback only. When upstream `/models` discovery succeeds the
  // live catalog is authoritative and this list is not used.
  const modelList = (
    process.env.COPILOT_API_MODELS ??
    [
      // Anthropic
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-opus-4.8",
      "claude-opus-4.7",
      "claude-opus-4.6",
      "claude-sonnet-4.6",
      "claude-sonnet-4.5",
      "claude-haiku-4.5",
      // OpenAI / Azure (chat-completions)
      "gpt-5.4",
      "gpt-5-mini",
      // Google
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
      // Responses-only (transparently bridged)
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "grok-4.5",
      "mai-code-1-flash-picker",
    ].join(",")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Fallback routing hints, used only when the live catalog is unavailable.
  // Normally derived from each model's upstream `supported_endpoints`.
  const responsesOnlyModels = (
    process.env.COPILOT_API_RESPONSES_MODELS ??
    [
      "chamomile",
      "gpt-5.3-codex",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "grok-4.5",
      "mai-code-1-flash-picker",
    ].join(",")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const maxCompletionTokensModels = (
    process.env.COPILOT_API_MAX_COMPLETION_TOKENS_MODELS ??
    "gpt-5.4"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    host: process.env.COPILOT_API_HOST ?? "127.0.0.1",
    port: intEnv("COPILOT_API_PORT", 4000),
    masterKey:
      process.env.COPILOT_API_MASTER_KEY ?? `copilot-${randomUUID()}`,
    requireAuth: process.env.COPILOT_API_REQUIRE_AUTH !== "0",
    tokenDir,
    accessTokenFile: join(tokenDir, "access-token"),
    apiKeyFile: join(tokenDir, "api-key.json"),
    copilotApiBase:
      process.env.COPILOT_API_BASE ?? "https://api.githubcopilot.com",
    copilotApiBaseExplicit: Boolean(process.env.COPILOT_API_BASE),
    copilotChatEndpoint:
      process.env.COPILOT_API_CHAT_ENDPOINT ?? "/chat/completions",
    editorVersion:
      process.env.COPILOT_EDITOR_VERSION ?? "vscode/1.95.0",
    editorPluginVersion:
      process.env.COPILOT_EDITOR_PLUGIN_VERSION ?? "copilot-chat/0.22.4",
    copilotIntegrationId:
      process.env.COPILOT_INTEGRATION_ID ?? "vscode-chat",
    userAgent:
      process.env.COPILOT_USER_AGENT ?? "GithubCopilot/1.155.0",
    githubClientId:
      process.env.GITHUB_COPILOT_CLIENT_ID ?? "Iv1.b507a08c87ecfe98",
    githubDeviceCodeUrl:
      process.env.GITHUB_COPILOT_DEVICE_CODE_URL ??
      "https://github.com/login/device/code",
    githubAccessTokenUrl:
      process.env.GITHUB_COPILOT_ACCESS_TOKEN_URL ??
      "https://github.com/login/oauth/access_token",
    copilotInternalTokenUrl:
      process.env.GITHUB_COPILOT_API_KEY_URL ??
      "https://api.github.com/copilot_internal/v2/token",
    requestTimeoutMs: intEnv("COPILOT_API_TIMEOUT_MS", 600_000),
    defaultModel:
      process.env.COPILOT_API_DEFAULT_MODEL ?? "claude-sonnet-4.6",
    smallFastModel:
      process.env.COPILOT_API_SMALL_MODEL ?? "claude-sonnet-4.6",
    modelList,
    modelDiscovery: process.env.COPILOT_API_MODEL_DISCOVERY !== "0",
    modelsCacheTtlMs: intEnv("COPILOT_API_MODELS_CACHE_TTL_MS", 60_000),
    modelsFailureBackoffMs: intEnv(
      "COPILOT_API_MODELS_FAILURE_BACKOFF_MS",
      30_000,
    ),
    modelsTimeoutMs: intEnv("COPILOT_API_MODELS_TIMEOUT_MS", 15_000),
    responsesOnlyModels,
    includeNonChatModels:
      process.env.COPILOT_API_INCLUDE_NON_CHAT_MODELS === "1",
    reasoningPassthrough: process.env.COPILOT_API_REASONING_PASSTHROUGH !== "0",
    maxCompletionTokensModels,
    logLevel: (process.env.COPILOT_API_LOG_LEVEL as Config["logLevel"]) ?? "info",
    logBodies: process.env.COPILOT_API_LOG_BODIES === "1",
    dropParams: process.env.COPILOT_API_DROP_PARAMS !== "0",
    dropParamsExtra: (process.env.COPILOT_API_DROP_PARAMS_EXTRA ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
};
