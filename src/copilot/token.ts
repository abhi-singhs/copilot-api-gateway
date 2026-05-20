import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "../config.js";
import { ensureSecureDir, readAccessToken } from "./auth.js";
import type { Logger } from "../logger.js";

interface CopilotApiKey {
  token: string;
  expires_at: number;
  refresh_in?: number;
  endpoints?: { api?: string };
  [k: string]: unknown;
}

export class CopilotTokenManager {
  private cached: CopilotApiKey | null = null;
  private inflight: Promise<CopilotApiKey> | null = null;

  constructor(private cfg: Config, private log: Logger) {}

  private async loadCachedFromDisk(): Promise<CopilotApiKey | null> {
    try {
      const raw = await readFile(this.cfg.apiKeyFile, "utf8");
      return JSON.parse(raw) as CopilotApiKey;
    } catch {
      return null;
    }
  }

  private async persist(key: CopilotApiKey): Promise<void> {
    await ensureSecureDir(dirname(this.cfg.apiKeyFile));
    await writeFile(this.cfg.apiKeyFile, JSON.stringify(key), "utf8");
    try { await chmod(this.cfg.apiKeyFile, 0o600); } catch { /* */ }
  }

  private isFresh(key: CopilotApiKey | null): boolean {
    if (!key) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    // refresh 5 min before expiry
    return key.expires_at - 300 > nowSec;
  }

  private async fetchNew(): Promise<CopilotApiKey> {
    const accessToken = await readAccessToken(this.cfg);
    if (!accessToken) {
      throw new Error(
        "No GitHub access token cached. Run: copilot-api-gateway auth",
      );
    }
    const res = await fetch(this.cfg.copilotInternalTokenUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `token ${accessToken}`,
        "editor-version": "vscode/1.85.1",
        "editor-plugin-version": "copilot/1.155.0",
        "user-agent": this.cfg.userAgent,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Copilot API token request failed: ${res.status} ${body}`,
      );
    }
    const data = (await res.json()) as CopilotApiKey;
    if (!data.token) {
      throw new Error(
        `Copilot token response missing 'token': ${JSON.stringify(data)}`,
      );
    }
    await this.persist(data);
    this.log.debug(
      `refreshed copilot api token, expires_at=${data.expires_at}`,
    );
    return data;
  }

  async getToken(): Promise<CopilotApiKey> {
    if (this.isFresh(this.cached)) return this.cached!;

    if (!this.cached) {
      this.cached = await this.loadCachedFromDisk();
      if (this.isFresh(this.cached)) return this.cached!;
    }

    if (!this.inflight) {
      this.inflight = this.fetchNew()
        .then((k) => {
          this.cached = k;
          return k;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
  }
}
