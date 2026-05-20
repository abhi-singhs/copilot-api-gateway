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
  copilotApiBase: string;
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
   * Models that must be dispatched to the upstream `/responses` endpoint
   * instead of `/chat/completions`. Auto-translated transparently.
   */
  responsesOnlyModels: string[];
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

  const modelList = (
    process.env.COPILOT_API_MODELS ??
    [
      // Anthropic
      "claude-opus-4.7",
      "claude-opus-4.6",
      "claude-sonnet-4.6",
      "claude-sonnet-4.5",
      "claude-haiku-4.5",
      // OpenAI / Azure (chat-completions)
      "gpt-5.2",
      "gpt-5-mini",
      "gpt-4.1",
      "gpt-4o",
      // Google
      "gemini-2.5-pro",
      "gemini-3.5-flash",
      // Responses-only (transparently bridged)
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
    ].join(",")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const responsesOnlyModels = (
    process.env.COPILOT_API_RESPONSES_MODELS ??
    "gpt-5.3-codex,gpt-5.2-codex,gpt-5.4-mini,gpt-5.5"
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
    responsesOnlyModels,
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
