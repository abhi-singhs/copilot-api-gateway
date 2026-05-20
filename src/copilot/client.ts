import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { CopilotTokenManager } from "./token.js";
import { logBody, tapResponse } from "../log-tap.js";

export interface UpstreamResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/**
 * POST to https://api.githubcopilot.com/chat/completions with the required
 * headers Copilot's edge gates on (Editor-Version, Copilot-Integration-Id,
 * etc.). Returns the raw upstream Response — the caller decides whether to
 * forward as SSE or read the JSON body.
 *
 * On HTTP 401, the cached API token is invalidated and the request retried
 * once with a fresh token.
 */
export class CopilotClient {
  constructor(
    private cfg: Config,
    private tokens: CopilotTokenManager,
    private log: Logger,
  ) {}

  private async buildHeaders(
    apiToken: string,
    stream: boolean,
    sessionId?: string,
    requestId?: string,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiToken}`,
      accept: stream ? "text/event-stream" : "application/json",
      "content-type": "application/json",
      "editor-version": this.cfg.editorVersion,
      "editor-plugin-version": this.cfg.editorPluginVersion,
      "copilot-integration-id": this.cfg.copilotIntegrationId,
      "user-agent": this.cfg.userAgent,
      "openai-intent": "conversation-panel",
      "x-github-api-version": "2025-04-01",
      "x-request-id": requestId ?? randomUUID(),
      "vscode-sessionid": sessionId ?? randomUUID(),
      "vscode-machineid": process.env.COPILOT_MACHINE_ID ?? "copilot-api-gateway",
    };
    return headers;
  }

  /**
   * Send a request to the upstream Copilot edge.
   *
   * `path` selects the endpoint (`/chat/completions` or `/responses`).
   * Caller MUST not retry on connection-reset; we already retry once on 401.
   */
  async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const stream = body.stream === true;
    const url = `${this.cfg.copilotApiBase}${path}`;
    const sessionId = randomUUID();
    const requestId = randomUUID();

    const doFetch = async (token: string): Promise<Response> => {
      const headers = await this.buildHeaders(token, stream, sessionId, requestId);
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
      try {
        return await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(t);
      }
    };

    let key = await this.tokens.getToken();
    if (this.cfg.logBodies) {
      logBody(this.log, `→ UPSTREAM ${url}`, body);
    }
    let res = await doFetch(key.token);

    if (res.status === 401) {
      this.log.warn("upstream 401, invalidating cached copilot api token and retrying once");
      this.tokens.invalidate();
      key = await this.tokens.getToken();
      res = await doFetch(key.token);
    }
    return tapResponse(res, this.log, `← UPSTREAM ${url}`, this.cfg.logBodies);
  }

  chatCompletions(body: Record<string, unknown>): Promise<Response> {
    return this.post(this.cfg.copilotChatEndpoint, body);
  }

  responses(body: Record<string, unknown>): Promise<Response> {
    return this.post("/responses", body);
  }
}
