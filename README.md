# copilot-api-gateway

> ⚠️ **Unofficial project.** This is not affiliated with, endorsed by, or
> supported by GitHub, Microsoft, Anthropic, OpenAI, or Google. "GitHub
> Copilot", "Claude", "Claude Code", "Anthropic", "OpenAI", "Codex" and
> "Gemini" are trademarks of their respective owners and are used here
> for descriptive purposes only.
>
> This gateway works by impersonating an allowlisted GitHub Copilot
> client (sending the same `Editor-Version` / `Copilot-Integration-Id`
> headers an IDE would send). Routing your Copilot subscription through
> non-IDE tools may violate your Copilot terms of service and consume
> Copilot quota faster than IDE chat does. Use at your own risk. The
> authors accept no liability for account suspension, quota exhaustion,
> data loss, or any other consequence of using this software.

A small, single-purpose local HTTP gateway that proxies **GitHub Copilot** as
both an **Anthropic Messages API** (`/v1/messages`) and an **OpenAI Chat
Completions API** (`/v1/chat/completions`).

- ✅ Anthropic SSE streaming with proper `message_start` / `content_block_*` /
  `message_delta` / `message_stop` events, including incremental
  `input_json_delta` for tool calls
- ✅ OpenAI Chat Completions passthrough (non-stream + SSE)
- ✅ **Responses API bridge** — codex / gpt-5.5 / gpt-5.4-mini are accepted
  on `/v1/chat/completions` and `/v1/messages` and transparently routed
  through `/responses` upstream
- ✅ **Per-model shaping** — `gpt-5.4` etc. automatically get
  `max_tokens` rewritten as `max_completion_tokens`
- ✅ GitHub OAuth device-flow with cached token + automatic Copilot API token
  refresh
- ✅ Required Copilot edge headers (`Editor-Version`, `Copilot-Integration-Id`,
  etc.) built in
- ✅ Local master-key auth
- ✅ Drops Anthropic-only params Copilot rejects (`thinking`, `cache_control`,
  `metadata`, `service_tier`, …)
- ✅ Single binary (`npx copilot-api-gateway`), no Python
- ✅ Works with Claude Code, Codex, OpenAI SDKs, `curl`, etc.

## Quick start

```bash
# 1. Install (no global needed — npx works)
npx copilot-api-gateway help

# 2. Authenticate with GitHub Copilot (one-time)
npx copilot-api-gateway auth
# → prints a github.com/login/device URL + code, waits for approval

# 3. Run the gateway (default 127.0.0.1:4000)
COPILOT_API_MASTER_KEY=mysecret npx copilot-api-gateway start

# 4. Point any client at it
curl http://127.0.0.1:4000/v1/models -H "Authorization: Bearer mysecret"
```

Get the env vars to source into any shell:

```bash
COPILOT_API_MASTER_KEY=mysecret npx copilot-api-gateway print-env
# export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
# export ANTHROPIC_AUTH_TOKEN=mysecret
# export ANTHROPIC_MODEL=claude-sonnet-4.6
# export OPENAI_BASE_URL=http://127.0.0.1:4000/v1
# export OPENAI_API_KEY=mysecret
# ...
```

## Use with Claude Code

```bash
COPILOT_API_MASTER_KEY=mysecret npx copilot-api-gateway start &
eval "$(COPILOT_API_MASTER_KEY=mysecret npx copilot-api-gateway print-env)"
claude
```

Or merge the env vars into `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
    "ANTHROPIC_AUTH_TOKEN": "mysecret",
    "ANTHROPIC_MODEL": "claude-sonnet-4.6",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-sonnet-4.6",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

## Use with OpenAI SDKs

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:4000/v1", api_key="mysecret")
client.chat.completions.create(
    model="claude-sonnet-4.6",
    messages=[{"role": "user", "content": "hello"}],
)
```

```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:4000/v1", apiKey: "mysecret" });
await client.chat.completions.create({
  model: "claude-sonnet-4.6",
  messages: [{ role: "user", content: "hello" }],
});
```

## Commands

| Command     | Description |
|-------------|-------------|
| `start`     | Run the HTTP gateway (default command) |
| `auth`      | Run GitHub device flow and cache credentials |
| `verify`    | Hit `/health` and `/v1/models` of a running gateway |
| `print-key` | Print the master key the gateway will accept |
| `print-env` | Print shell `export` lines for Claude Code / OpenAI clients |
| `help`      | Show help |

## Configuration

All configuration is via environment variables.

### Server

| Variable                        | Default                             | Description |
|---------------------------------|-------------------------------------|-------------|
| `COPILOT_API_HOST`              | `127.0.0.1`                         | bind host |
| `COPILOT_API_PORT`              | `4000`                              | bind port |
| `COPILOT_API_MASTER_KEY`        | random per run                      | bearer key clients must send |
| `COPILOT_API_REQUIRE_AUTH`      | `1`                                 | set `0` to disable local auth (not recommended) |
| `COPILOT_API_LOG_LEVEL`         | `info`                              | `debug`\|`info`\|`warn`\|`error` |
| `COPILOT_API_LOG_BODIES`        | unset (`0`)                          | set `1` to log every inbound + upstream request/response body (verbose; useful for debugging) |
| `COPILOT_API_TIMEOUT_MS`        | `600000`                            | upstream request timeout |
| `COPILOT_API_DROP_PARAMS`       | `1`                                 | set `0` to disable the sanitizer entirely (pass everything through) |
| `COPILOT_API_DROP_PARAMS_EXTRA` | unset                               | comma-separated extra top-level fields to strip (e.g. `foo,bar`) |

### Credentials cache

| Variable                        | Default                                                | Description |
|---------------------------------|--------------------------------------------------------|-------------|
| `COPILOT_API_TOKEN_DIR`         | `~/.config/copilot-api-gateway/github_copilot`         | where `access-token` + `api-key.json` are cached |

The `access-token` file is your long-lived GitHub OAuth token. The
`api-key.json` file is the short-lived Copilot API token (auto-refreshed
about 5 minutes before expiry). Both files are `chmod 600`.

### Models

| Variable                        | Default                             | Description |
|---------------------------------|-------------------------------------|-------------|
| `COPILOT_API_DEFAULT_MODEL`     | `claude-sonnet-4.6`                 | reported in `print-env` |
| `COPILOT_API_SMALL_MODEL`       | `claude-sonnet-4.6`                 | reported in `print-env` |
| `COPILOT_API_MODELS`            | curated list (see below)            | comma-separated list for `/v1/models` |
| `COPILOT_API_RESPONSES_MODELS`  | `gpt-5.3-codex,gpt-5.2-codex,gpt-5.4-mini,gpt-5.5` | models that must go to `/responses`; transparently bridged |
| `COPILOT_API_MAX_COMPLETION_TOKENS_MODELS` | `gpt-5.4`                | models that require `max_completion_tokens` instead of `max_tokens` |

The default model list contains models verified to work on the current
Copilot edge:

```
claude-opus-4.7, claude-opus-4.6, claude-sonnet-4.6, claude-sonnet-4.5,
claude-haiku-4.5, gpt-5.2, gpt-5-mini, gpt-4.1, gpt-4o,
gemini-2.5-pro, gemini-3.5-flash,
gpt-5.3-codex, gpt-5.2-codex, gpt-5.4, gpt-5.4-mini, gpt-5.5
```

The last five are dispatched to the `/responses` endpoint behind the
scenes. Clients keep speaking Chat Completions or Anthropic Messages —
the gateway translates both ways.

### Endpoint dispatch & per-model shaping

The gateway always speaks Chat Completions or Anthropic Messages to its
clients. Internally it picks the right upstream endpoint per model:

| Model | Upstream endpoint | Shaping |
|---|---|---|
| Default | `POST /chat/completions` | none |
| `gpt-5.4` (and any listed in `COPILOT_API_MAX_COMPLETION_TOKENS_MODELS`) | `POST /chat/completions` | `max_tokens` → `max_completion_tokens` |
| `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.4-mini`, `gpt-5.5` (and any listed in `COPILOT_API_RESPONSES_MODELS`) | `POST /responses` | Chat ↔ Responses bidirectional translation, incl. streaming and tool calls |

`POST /v1/responses` is also exposed for callers who already speak the
native OpenAI Responses API.

### Copilot edge headers

Requests to GitHub Copilot must impersonate an approved editor. The
gateway sends:

```
Editor-Version: vscode/1.95.0
Copilot-Integration-Id: vscode-chat
Editor-Plugin-Version: copilot-chat/0.22.4
User-Agent: GithubCopilot/1.155.0
```

| Variable                        | Default                             | Description |
|---------------------------------|-------------------------------------|-------------|
| `COPILOT_EDITOR_VERSION`        | `vscode/1.95.0`                     | sent as `Editor-Version` |
| `COPILOT_EDITOR_PLUGIN_VERSION` | `copilot-chat/0.22.4`               | sent as `Editor-Plugin-Version` |
| `COPILOT_INTEGRATION_ID`        | `vscode-chat`                       | sent as `Copilot-Integration-Id` |
| `COPILOT_USER_AGENT`            | `GithubCopilot/1.155.0`             | sent as `User-Agent` |

Known-good `Copilot-Integration-Id` values include `vscode-chat`,
`vscode-copilot`, `jetbrains-chat`, `neovim-chat`. There is no
`claude-code` or `copilot-api-gateway` integration ID — Copilot's edge
will reject unknown values.

### OAuth client

| Variable                                | Default                                                  |
|-----------------------------------------|----------------------------------------------------------|
| `GITHUB_COPILOT_CLIENT_ID`              | `Iv1.b507a08c87ecfe98` (well-known VS Code Copilot)      |
| `GITHUB_COPILOT_DEVICE_CODE_URL`        | `https://github.com/login/device/code`                   |
| `GITHUB_COPILOT_ACCESS_TOKEN_URL`       | `https://github.com/login/oauth/access_token`            |
| `GITHUB_COPILOT_API_KEY_URL`            | `https://api.github.com/copilot_internal/v2/token`       |

## API

### `POST /v1/chat/completions`

OpenAI-compatible chat completions. The body is forwarded mostly verbatim
to `https://api.githubcopilot.com/chat/completions` after the gateway
strips a small set of Anthropic-only fields (`thinking`, `cache_control`,
`metadata`, `service_tier`, `system`, `anthropic_beta`, `extra_headers`,
`extra_body`, `container`). Both `stream:true` (SSE) and `stream:false`
are supported.

### `POST /v1/messages`

Anthropic-compatible Messages API. The gateway translates the request to
the OpenAI shape, forwards it to Copilot, and translates the response
(including SSE) back to Anthropic's framing.

Translation notes:

- `system` (string or `text` blocks) → OpenAI `system` message
- `tool_use` (assistant) → OpenAI `tool_calls`
- `tool_result` (user) → OpenAI `role: "tool"` messages (emitted just
  before any text/image user content in the same turn so they directly
  follow the assistant turn that requested them)
- `image` (`base64` or `url`) → OpenAI `image_url` (data URL or remote URL)
- `tool_choice` mapping: `auto`→`auto`, `any`→`required`, `none`→`none`,
  `{type:"tool", name}`→`{type:"function", function:{name}}`
- Streaming: emits `message_start`, `ping`, `content_block_start`,
  `content_block_delta` (`text_delta` and `input_json_delta`),
  `content_block_stop`, `message_delta` (with `stop_reason` + usage), and
  `message_stop`
- Dropped: `thinking`, `redacted_thinking`, `cache_control` (on top-level
  or any content block), `document` blocks, `metadata`, `service_tier`,
  `anthropic_beta` headers

### `POST /v1/responses`

Native passthrough to the OpenAI Responses API. Useful for clients that
already speak Responses. Targets the same Copilot edge as the bridged
flow above. Streaming is supported.

### `GET /v1/models`

Returns the configured model list.

### `GET /health`

Liveness check (no auth required).

## Sanitizer — what gets silently dropped

GitHub Copilot's `/chat/completions` edge rejects (or silently mishandles) a
handful of Anthropic-only and OpenAI-extension fields. The gateway strips
them before forwarding so clients written against either API "just work"
without `UnsupportedParamsError`. Every drop is logged at `debug` level
with the exact JSON path that was removed (`messages[3].content[1].cache_control`,
`tools[0].function.cache_control`, …).

The defaults are conservative — anything Copilot accepts passes through.

**Top-level fields dropped:**

```
anthropic_version, anthropic_beta, thinking, cache_control, metadata,
service_tier, extra_headers, extra_body, container, mcp_servers,
prompt_cache_key, safety_identifier, reasoning, reasoning_effort,
modalities, audio, prediction, store, web_search_options
```

**Keys stripped from every message, content block, and tool (recursive):**

```
cache_control
```

**Content-block `type` values removed from `messages[*].content[]`:**

```
thinking, redacted_thinking, document, server_tool_use,
web_search_tool_result, code_execution_tool_result, container_upload
```

**Special case — `system`:** a top-level `system: string` or
`system: [{type:"text", text:"..."}]` (Anthropic-style) is **converted**
into a leading `messages[0]` system message rather than dropped, so
Anthropic-only clients can hit `/v1/chat/completions` and still get the
expected behavior.

**Add your own drops** without rebuilding:

```bash
COPILOT_API_DROP_PARAMS_EXTRA=foo,bar copilot-api-gateway start
# now top-level "foo" and "bar" are also stripped
```

**Disable the sanitizer entirely** (everything is forwarded as-is — Copilot
will then 400 anything it doesn't recognize):

```bash
COPILOT_API_DROP_PARAMS=0 copilot-api-gateway start
```

The Anthropic `/v1/messages` route translates the request into the OpenAI
shape from scratch, so most Anthropic-only fields never make it to the
sanitizer in the first place. The sanitizer still runs over the translated
body as defense-in-depth (and to honour `COPILOT_API_DROP_PARAMS_EXTRA`).

## What this does NOT do

This gateway is intentionally small and Copilot-only. It deliberately does
**not** include:

- Anthropic prompt caching (Copilot ignores `cache_control`)
- Anthropic extended thinking (Copilot rejects `thinking`)
- Anthropic hosted tools (web search, code execution, computer use,
  citations, native PDF input, Files/Memory tool, Batch API)
- Cost tracking / budgets / virtual keys / DB-backed routing

If you need those, reach for a fuller proxy. If you only need a small,
auditable, Copilot-only proxy for Claude Code / Codex / OpenAI SDKs, this
is for you.

## Development

```bash
git clone <this-repo>
cd copilot-api-gateway
npm install
npm run typecheck
npm run build
node dist/cli.js help

# live dev with tsx
npm run dev -- start
```

## Security notes

- The default `COPILOT_API_REQUIRE_AUTH=1` requires a `Bearer <master-key>`
  on every `/v1/*` request. The key is generated per-run unless you set
  `COPILOT_API_MASTER_KEY` yourself.
- The token cache directory (`COPILOT_API_TOKEN_DIR`) is created with
  mode `0700`; cached credential files are written `0600`.
- Bind defaults to `127.0.0.1`. Do not bind this to a public interface.
- Be aware this routes all traffic through your personal GitHub Copilot
  account and consumes your Copilot quota. Some clients (e.g. Claude
  Code) can burn quota faster than IDE chat does.

## License

MIT

## Disclaimer

This is an **unofficial** project. It is not affiliated with, endorsed
by, or sponsored by GitHub, Microsoft, Anthropic, OpenAI, or Google.
All trademarks are the property of their respective owners.

The gateway sends `Editor-Version` and `Copilot-Integration-Id` headers
that mimic an allowlisted IDE so the Copilot edge will accept requests.
Doing this in a non-IDE context may violate GitHub's Copilot terms of
service. The software is provided "as is", without warranty of any
kind. The authors accept no liability for account suspension, quota
exhaustion, data loss, or any other consequence of using this gateway.
