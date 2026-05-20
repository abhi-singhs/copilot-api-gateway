import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";
import { createLogger } from "./logger.js";
import { startDeviceFlow } from "./copilot/auth.js";
import { CopilotTokenManager } from "./copilot/token.js";

const HELP = `copilot-api-gateway — local Anthropic + OpenAI gateway to GitHub Copilot

Usage:
  copilot-api-gateway <command> [options]

Commands:
  start        Start the HTTP gateway (default)
  auth         Run GitHub device-flow authentication and cache the token
  verify       Hit /health and /v1/models against a running gateway
  print-key    Print the master key the gateway will accept
  print-env    Print env-var exports for Claude Code / OpenAI clients
  help         Show this message

Environment variables (most useful):
  COPILOT_API_HOST              bind host (default 127.0.0.1)
  COPILOT_API_PORT              bind port (default 4000)
  COPILOT_API_MASTER_KEY        local proxy bearer key (default: random per run)
  COPILOT_API_REQUIRE_AUTH=0    disable local auth (NOT recommended)
  COPILOT_API_TOKEN_DIR         where to cache GitHub credentials
  COPILOT_API_DEFAULT_MODEL     model to advertise/default to
  COPILOT_API_MODELS            comma-separated model list exposed at /v1/models
  COPILOT_EDITOR_VERSION        Editor-Version header (default vscode/1.95.0)
  COPILOT_INTEGRATION_ID        Copilot-Integration-Id header (default vscode-chat)
  COPILOT_API_LOG_LEVEL         debug|info|warn|error
`;

const main = async (argv: string[]): Promise<void> => {
  const cmd = argv[2] ?? "start";
  const cfg = loadConfig();
  const log = createLogger(cfg.logLevel);

  switch (cmd) {
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return;

    case "print-key":
      process.stdout.write(cfg.masterKey + "\n");
      return;

    case "print-env": {
      const base = `http://${cfg.host}:${cfg.port}`;
      process.stdout.write(
        [
          `# copilot-api-gateway client env`,
          `export ANTHROPIC_BASE_URL=${base}`,
          `export ANTHROPIC_AUTH_TOKEN=${cfg.masterKey}`,
          `export ANTHROPIC_MODEL=${cfg.defaultModel}`,
          `export ANTHROPIC_SMALL_FAST_MODEL=${cfg.smallFastModel}`,
          `export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`,
          `export OPENAI_BASE_URL=${base}/v1`,
          `export OPENAI_API_KEY=${cfg.masterKey}`,
          ``,
        ].join("\n"),
      );
      return;
    }

    case "auth": {
      log.info(`Starting GitHub Copilot device flow…`);
      log.info(`Token cache: ${cfg.tokenDir}`);
      const { accessToken } = await startDeviceFlow(cfg, ({ verificationUri, userCode }) => {
        process.stdout.write(
          `\nOpen: ${verificationUri}\nCode: ${userCode}\nWaiting for approval…\n\n`,
        );
      });
      log.info(`Got GitHub access token (length ${accessToken.length}). Fetching Copilot API token…`);
      const tokens = new CopilotTokenManager(cfg, log);
      const key = await tokens.getToken();
      log.info(`Copilot API token cached, expires_at=${key.expires_at}.`);
      log.info(`Ready. Start the gateway with: copilot-api-gateway start`);
      return;
    }

    case "verify": {
      const base = `http://${cfg.host}:${cfg.port}`;
      const headers: Record<string, string> = { authorization: `Bearer ${cfg.masterKey}` };
      const health = await fetch(`${base}/health`).then((r) => r.json()).catch((e: Error) => ({ error: e.message }));
      const models = await fetch(`${base}/v1/models`, { headers }).then((r) => r.json()).catch((e: Error) => ({ error: e.message }));
      process.stdout.write(JSON.stringify({ base, health, models }, null, 2) + "\n");
      return;
    }

    case "start":
    case undefined: {
      const { app } = createApp(cfg);
      const server = serve(
        { fetch: app.fetch, hostname: cfg.host, port: cfg.port },
        ({ address, port }) => {
          log.info(`copilot-api-gateway listening on http://${address}:${port}`);
          log.info(`Anthropic endpoint:  POST http://${cfg.host}:${cfg.port}/v1/messages`);
          log.info(`OpenAI endpoint:     POST http://${cfg.host}:${cfg.port}/v1/chat/completions`);
          log.info(`Master key (Bearer): ${cfg.masterKey}`);
          if (!cfg.requireAuth) log.warn(`local auth DISABLED (COPILOT_API_REQUIRE_AUTH=0)`);
        },
      );
      const shutdown = () => {
        log.info("shutting down…");
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }

    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
};

main(process.argv).catch((err: Error) => {
  process.stderr.write(`fatal: ${err.message}\n`);
  if (process.env.COPILOT_API_LOG_LEVEL === "debug") {
    process.stderr.write((err.stack ?? "") + "\n");
  }
  process.exit(1);
});
