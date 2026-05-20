import { mkdir, chmod, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "../config.js";

const GITHUB_HEADERS = (cfg: Config): Record<string, string> => ({
  accept: "application/json",
  "content-type": "application/json",
  "editor-version": "vscode/1.85.1",
  "editor-plugin-version": "copilot/1.155.0",
  "user-agent": cfg.userAgent,
});

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const ensureSecureDir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true });
  try { await chmod(path, 0o700); } catch { /* best-effort on non-POSIX */ }
};

export const readAccessToken = async (cfg: Config): Promise<string | null> => {
  try {
    return (await readFile(cfg.accessTokenFile, "utf8")).trim();
  } catch {
    return null;
  }
};

export const writeAccessToken = async (cfg: Config, token: string): Promise<void> => {
  await ensureSecureDir(dirname(cfg.accessTokenFile));
  await writeFile(cfg.accessTokenFile, token, "utf8");
  try { await chmod(cfg.accessTokenFile, 0o600); } catch { /* */ }
};

export interface DeviceFlowResult {
  accessToken: string;
}

export const startDeviceFlow = async (
  cfg: Config,
  onPrompt: (info: { verificationUri: string; userCode: string }) => void,
): Promise<DeviceFlowResult> => {
  const headers = GITHUB_HEADERS(cfg);

  const deviceRes = await fetch(cfg.githubDeviceCodeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ client_id: cfg.githubClientId, scope: "read:user" }),
  });
  if (!deviceRes.ok) {
    throw new Error(`device code request failed: ${deviceRes.status} ${await deviceRes.text()}`);
  }
  const device = (await deviceRes.json()) as DeviceCodeResponse;
  const interval = (device.interval ?? 5) * 1000;
  const expiresAt = Date.now() + (device.expires_in ?? 900) * 1000;

  onPrompt({ verificationUri: device.verification_uri, userCode: device.user_code });

  let currentInterval = interval;
  while (Date.now() < expiresAt) {
    await sleep(currentInterval);
    const res = await fetch(cfg.githubAccessTokenUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_id: cfg.githubClientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    if (!res.ok) {
      throw new Error(`access token poll failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as AccessTokenResponse;
    if (data.access_token) {
      await writeAccessToken(cfg, data.access_token);
      return { accessToken: data.access_token };
    }
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { currentInterval += 5000; continue; }
    if (data.error === "expired_token" || data.error === "access_denied") {
      throw new Error(`device flow ended: ${data.error}: ${data.error_description ?? ""}`);
    }
    throw new Error(`unexpected device flow response: ${JSON.stringify(data)}`);
  }
  throw new Error("device flow timed out");
};
