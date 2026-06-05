# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
