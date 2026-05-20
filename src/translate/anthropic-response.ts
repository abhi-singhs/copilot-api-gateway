/**
 * Translate an OpenAI /v1/chat/completions response (non-stream + SSE) into
 * an Anthropic /v1/messages response.
 */

import { randomUUID } from "node:crypto";

interface OpenAIToolCall {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface OpenAINonStreamMessage {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAINonStreamChoice {
  index: number;
  message: OpenAINonStreamMessage;
  finish_reason?: string | null;
}

interface OpenAINonStreamResponse {
  id?: string;
  model?: string;
  choices?: OpenAINonStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const mapStopReason = (
  finish: string | null | undefined,
  hasToolCall: boolean,
): "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" => {
  if (hasToolCall || finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "stop") return "end_turn";
  if (finish === "content_filter") return "end_turn";
  return "end_turn";
};

export const translateNonStreamResponse = (
  upstream: OpenAINonStreamResponse,
  model: string,
): Record<string, unknown> => {
  const choice = upstream.choices?.[0];
  const msg = choice?.message ?? {};

  const content: Array<Record<string, unknown>> = [];

  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  }

  const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
  if (hasToolCalls) {
    for (const tc of msg.tool_calls!) {
      const fn = tc.function ?? {};
      let parsed: unknown = {};
      try {
        parsed = fn.arguments ? JSON.parse(fn.arguments) : {};
      } catch {
        parsed = { _raw: fn.arguments ?? "" };
      }
      content.push({
        type: "tool_use",
        id: tc.id ?? `toolu_${randomUUID()}`,
        name: fn.name ?? "",
        input: parsed,
      });
    }
  }

  const usage = upstream.usage ?? {};
  return {
    id: upstream.id ?? `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: upstream.model ?? model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason, hasToolCalls),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
};

// ---------------------------------------------------------------------------
// Streaming translation
// ---------------------------------------------------------------------------

/**
 * Build an SSE event string in Anthropic's framing.
 */
const sseEvent = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

interface StreamToolCallState {
  id: string;
  name: string;
  argsBuffer: string;
  blockIndex: number;
}

/**
 * Convert an OpenAI SSE stream from Copilot into an Anthropic SSE stream.
 */
export const translateStreamResponse = (
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const messageId = `msg_${randomUUID()}`;
      let buffer = "";
      let started = false;
      let textBlockOpen = false;
      let textBlockIndex = 0;
      let nextBlockIndex = 0;
      let upstreamModel = requestedModel;
      const toolCalls = new Map<number, StreamToolCallState>();
      let finishReason: string | null | undefined;
      let promptTokens = 0;
      let completionTokens = 0;

      const emit = (event: string, data: unknown): void => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      const emitMessageStart = (): void => {
        emit("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: upstreamModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        emit("ping", { type: "ping" });
      };

      const ensureTextBlock = (): void => {
        if (textBlockOpen) return;
        textBlockIndex = nextBlockIndex++;
        textBlockOpen = true;
        emit("content_block_start", {
          type: "content_block_start",
          index: textBlockIndex,
          content_block: { type: "text", text: "" },
        });
      };

      const closeTextBlock = (): void => {
        if (!textBlockOpen) return;
        emit("content_block_stop", {
          type: "content_block_stop",
          index: textBlockIndex,
        });
        textBlockOpen = false;
      };

      const handleToolCallDelta = (tc: OpenAIToolCall): void => {
        const idx = tc.index ?? 0;
        let state = toolCalls.get(idx);
        if (!state) {
          // Close any open text block before starting a tool_use block.
          closeTextBlock();
          state = {
            id: tc.id ?? `toolu_${randomUUID()}`,
            name: tc.function?.name ?? "",
            argsBuffer: "",
            blockIndex: nextBlockIndex++,
          };
          toolCalls.set(idx, state);
          emit("content_block_start", {
            type: "content_block_start",
            index: state.blockIndex,
            content_block: {
              type: "tool_use",
              id: state.id,
              name: state.name,
              input: {},
            },
          });
        } else if (tc.id && !state.id.startsWith("toolu_")) {
          // ignore — already have an upstream id
        }
        if (tc.function?.name && !state.name) {
          state.name = tc.function.name;
        }
        const argChunk = tc.function?.arguments;
        if (typeof argChunk === "string" && argChunk.length > 0) {
          state.argsBuffer += argChunk;
          emit("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: argChunk,
            },
          });
        }
      };

      const handleChunk = (raw: string): void => {
        const trimmed = raw.trim();
        if (!trimmed.startsWith("data:")) return;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") return;
        let evt: {
          model?: string;
          choices?: Array<{
            index?: number;
            delta?: {
              role?: string;
              content?: string | null;
              tool_calls?: OpenAIToolCall[];
            };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
          };
        };
        try {
          evt = JSON.parse(dataStr);
        } catch {
          return;
        }
        if (evt.model) upstreamModel = evt.model;
        if (evt.usage) {
          if (typeof evt.usage.prompt_tokens === "number") {
            promptTokens = evt.usage.prompt_tokens;
          }
          if (typeof evt.usage.completion_tokens === "number") {
            completionTokens = evt.usage.completion_tokens;
          }
        }
        if (!started) {
          started = true;
          emitMessageStart();
        }

        const choice = evt.choices?.[0];
        if (!choice) return;

        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          ensureTextBlock();
          emit("content_block_delta", {
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: delta.content },
          });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) handleToolCallDelta(tc);
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      };

      const flushBuffer = (final: boolean): void => {
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          // each SSE chunk may have several lines; we only care about `data:`
          for (const line of chunk.split("\n")) {
            handleChunk(line);
          }
        }
        if (final && buffer.length > 0) {
          for (const line of buffer.split("\n")) handleChunk(line);
          buffer = "";
        }
      };

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          flushBuffer(false);
        }
        flushBuffer(true);

        if (!started) {
          // Upstream closed without any events — emit a minimal valid stream.
          emitMessageStart();
        }

        // Close any open blocks
        for (const state of toolCalls.values()) {
          emit("content_block_stop", {
            type: "content_block_stop",
            index: state.blockIndex,
          });
        }
        closeTextBlock();

        const hasToolUse = toolCalls.size > 0;
        const stopReason =
          hasToolUse || finishReason === "tool_calls"
            ? "tool_use"
            : finishReason === "length"
              ? "max_tokens"
              : "end_turn";

        emit("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            input_tokens: promptTokens,
            output_tokens: completionTokens,
          },
        });
        emit("message_stop", { type: "message_stop" });
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
};
