# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Catalog-driven endpoint routing: the upstream `supported_endpoints` field now
  decides whether a model goes to `/chat/completions` or `/responses`, so newly
  released and retired models route correctly with no config change. Previously
  six live responses-only models (`gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`, `grok-4.5`, `mai-code-1-flash-picker`, `chamomile`) were
  missing from the static list and paid a failed `/chat/completions` round-trip
  (~0.4–0.9s) on every request before the fallback rescued them.
- `reasoning_effort` passthrough: forwarded to models that advertise support,
  clamped to the nearest advertised level otherwise, and dropped for models
  without reasoning support. Translated to `reasoning: { effort }` on the
  Responses bridge, and `reasoning: { effort }` is accepted on input too.
- `/v1/models` now returns capability metadata: `context_window`,
  `max_output_tokens`, and `capabilities` (streaming, tool calls, vision,
  reasoning levels).
- The tenant's own API host from the Copilot token (`endpoints.api`, e.g.
  `https://api.enterprise.githubcopilot.com`) is now used automatically, which
  matters for enterprise/proxima tenants not authorized against the public
  host. `COPILOT_API_BASE` still overrides.
- `npm run test:models`: model matrix smoke test covering chat, streaming, tool
  calls and Anthropic Messages per vendor/routing path; exits non-zero on
  failure so catalog drift is caught.
- New configuration: `COPILOT_API_INCLUDE_NON_CHAT_MODELS` (default off),
  `COPILOT_API_REASONING_PASSTHROUGH` (default on),
  `COPILOT_API_MODELS_FAILURE_BACKOFF_MS` (default `30000`) and
  `COPILOT_API_MODELS_TIMEOUT_MS` (default `15000`). The latter two keep a
  degraded `/models` host from being re-hit on every request or stalling
  proxied completions for the full `COPILOT_API_TIMEOUT_MS` (10 minutes).

### Fixed

- `GET /v1/models` no longer advertises models that upstream cannot serve. The
  static fallback list was merged into successful discovery results, which kept
  the retired `gpt-5.2`, `gemini-2.5-pro` and `gpt-5.2-codex` in the catalog —
  all three returned `400 model_not_supported` when selected.
- `reasoning` and `reasoning_effort` are no longer stripped by the sanitizer.
  Copilot accepts both, and most current models (including every Claude model)
  advertise `reasoning_effort` support, so clients requesting a reasoning level
  were being silently ignored.
- Embedding and completion models are no longer listed as chat models; the
  gateway exposes no endpoint that can call them.

### Changed

- Refreshed the static fallback model list to the current catalog: added
  `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.8`, `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna`, `grok-4.5`, `gemini-3.6-flash`,
  `gemini-3.1-pro-preview` and `mai-code-1-flash-picker`; removed the retired
  `gpt-5.2`, `gemini-2.5-pro`, `gpt-4.1`, `gpt-4o` and `gpt-5.2-codex`.
- `COPILOT_API_RESPONSES_MODELS` is now a fallback used only when discovery is
  unavailable, rather than the primary routing source.
- Synced `package-lock.json` to `0.2.0` (it still declared `0.1.0` and a removed
  `copilot-api` bin entry).

## [0.2.0] - 2026-06-05

### Added

- Automatic upstream model discovery for `GET /v1/models`: the gateway now
  queries Copilot's `/models` catalog, caches it (configurable TTL), and
  merges it with the local fallback list so all account-available models
  are exposed.
- Automatic endpoint fallback: chat and Messages requests now retry once on
  the alternate upstream endpoint (`/chat/completions` ↔ `/responses`) when
  the first route returns a model-unsupported style error, so newly added
  models work without manual route-list updates.
- New configuration: `COPILOT_API_MODEL_DISCOVERY` (default on) and
  `COPILOT_API_MODELS_CACHE_TTL_MS` (default `60000`).

### Changed

- `COPILOT_API_MODELS` is now treated as a fallback list, returned when
  upstream discovery is disabled or unavailable.

## [0.1.0] - 2026-05-20

### Added

- Initial release.
- Anthropic Messages API (`/v1/messages`) translation layer with SSE
  streaming (`message_start`, `content_block_*`, `message_delta`,
  `message_stop`, including `input_json_delta` for tool calls).
- OpenAI Chat Completions passthrough (`/v1/chat/completions`), both
  streaming and non-streaming.
- Native OpenAI Responses API passthrough (`/v1/responses`) plus
  transparent Chat ↔ Responses bridging for `gpt-5.3-codex`,
  `gpt-5.2-codex`, `gpt-5.4-mini`, and `gpt-5.5`.
- Per-model request shaping (`max_tokens` → `max_completion_tokens` for
  `gpt-5.4`-family models).
- GitHub OAuth device flow with on-disk credential cache and automatic
  Copilot API token refresh.
- Local master-key bearer auth, with optional opt-out.
- Sanitizer that strips Anthropic-only / unsupported fields Copilot
  rejects (`thinking`, `cache_control`, `metadata`, `service_tier`, …),
  configurable via `COPILOT_API_DROP_PARAMS*`.
- `start`, `auth`, `verify`, `print-key`, `print-env`, and `help` CLI
  commands.

[Unreleased]: https://github.com/abhi-singhs/copilot-api-gateway/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/abhi-singhs/copilot-api-gateway/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/abhi-singhs/copilot-api-gateway/releases/tag/v0.1.0
