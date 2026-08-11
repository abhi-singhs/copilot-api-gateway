/**
 * Bidirectional translation between OpenAI's Chat Completions API and
 * OpenAI's Responses API.
 *
 * GitHub Copilot exposes some models (gpt-5.3-codex, gpt-5.5, etc.) only
 * via `/responses`. The gateway accepts Chat Completions requests for
 * these models and transparently bridges them so existing clients keep
 * working.
 *
 * Spec references (OpenAI):
 *  - Responses request:  https://platform.openai.com/docs/api-reference/responses/create
 *  - Responses streaming events: https://platform.openai.com/docs/api-reference/responses-streaming
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Request: chat.completions → responses
// ---------------------------------------------------------------------------

type ChatRole = "system" | "user" | "assistant" | "tool" | "developer";

interface ChatMessage {
  role: ChatRole;
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface ResponsesInputMessage {
  type: "message";
  role: "system" | "user" | "assistant" | "developer";
  content: Array<Record<string, unknown>>;
}

interface ResponsesFunctionCall {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCall
  | ResponsesFunctionCallOutput;

const stringifyContent = (
  content: ChatMessage["content"],
): string => {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const t = (part as { type?: string }).type;
      if (t === "text") return ((part as { text?: string }).text ?? "");
      if (t === "input_text") return ((part as { text?: string }).text ?? "");
      return "";
    })
    .join("");
};

const userOrSystemContent = (
  content: ChatMessage["content"],
  role: ResponsesInputMessage["role"],
): Array<Record<string, unknown>> => {
  if (content === null || content === undefined) return [];
  const textType = role === "assistant" ? "output_text" : "input_text";

  if (typeof content === "string") {
    return [{ type: textType, text: content }];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const t = (part as { type?: string }).type;
    if (t === "text") {
      out.push({ type: textType, text: (part as { text?: string }).text ?? "" });
    } else if (t === "image_url") {
      const imgUrl = (part as { image_url?: { url?: string } }).image_url?.url;
      if (imgUrl) {
        // Responses API expects `input_image` blocks.
        out.push({ type: "input_image", image_url: imgUrl });
      }
    } else if (t === "input_text" || t === "input_image" || t === "output_text") {
      // Already in responses shape — pass through.
      out.push(part as Record<string, unknown>);
    }
  }
  return out;
};

/**
 * Translate an OpenAI Chat Completions request body into an OpenAI
 * Responses request body suitable for the upstream `/responses` endpoint.
 */
export const chatToResponsesRequest = (
  chat: Record<string, unknown>,
  opts: { reasoningEffort?: string | null } = {},
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};

  if (typeof chat.model === "string") out.model = chat.model;
  if (chat.stream === true) out.stream = true;

  // `max_tokens` and `max_completion_tokens` both map to `max_output_tokens`.
  // The Responses API rejects values below 16.
  const maxTok =
    (typeof chat.max_completion_tokens === "number"
      ? chat.max_completion_tokens
      : undefined) ??
    (typeof chat.max_tokens === "number" ? chat.max_tokens : undefined);
  if (typeof maxTok === "number") {
    out.max_output_tokens = Math.max(16, maxTok);
  }

  // Chat Completions spells this `reasoning_effort`; Responses expects
  // `reasoning: { effort }`. Callers resolve the effort against the model's
  // advertised levels and pass `null` to suppress it — the raw request value
  // is only consulted when the caller didn't resolve one at all, otherwise a
  // deliberate drop would be undone here.
  const effort =
    opts.reasoningEffort === null
      ? undefined
      : (opts.reasoningEffort ??
        (typeof chat.reasoning_effort === "string"
          ? (chat.reasoning_effort as string)
          : undefined));
  if (effort) out.reasoning = { effort };

  if (typeof chat.temperature === "number") out.temperature = chat.temperature;
  if (typeof chat.top_p === "number") out.top_p = chat.top_p;

  // System messages → `instructions` (cleaner than a leading system input
  // item; Responses API recommends this).
  const messages = Array.isArray(chat.messages)
    ? (chat.messages as ChatMessage[])
    : [];

  const systemTexts: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system" || m.role === "developer") {
      const s = stringifyContent(m.content);
      if (s) systemTexts.push(s);
      continue;
    }
    if (m.role === "assistant") {
      // Emit text content (if any) as an assistant message item.
      const text = stringifyContent(m.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      // Emit each tool_call as a separate function_call item.
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "",
          });
        }
      }
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id ?? "",
        output: stringifyContent(m.content),
      });
      continue;
    }
    // user
    input.push({
      type: "message",
      role: "user",
      content: userOrSystemContent(m.content, "user"),
    });
  }

  if (systemTexts.length > 0) out.instructions = systemTexts.join("\n\n");
  out.input = input;

  // Tools.
  if (Array.isArray(chat.tools) && chat.tools.length > 0) {
    out.tools = (chat.tools as Array<Record<string, unknown>>).map((t) => {
      const fn = (t.function as Record<string, unknown> | undefined) ?? {};
      return {
        type: "function",
        name: fn.name,
        description: fn.description ?? "",
        parameters: fn.parameters ?? { type: "object", properties: {} },
      };
    });
  }
  if (chat.tool_choice !== undefined) {
    // Same shape works in both APIs for "auto"|"required"|"none" and
    // {type:"function", function:{name}}; Responses wants {type:"function",name}
    // for the explicit form, so normalize.
    const tc = chat.tool_choice;
    if (tc && typeof tc === "object" && "function" in (tc as Record<string, unknown>)) {
      const fn = ((tc as { function?: { name?: string } }).function) ?? {};
      out.tool_choice = { type: "function", name: fn.name ?? "" };
    } else {
      out.tool_choice = tc;
    }
  }

  return out;
};

// ---------------------------------------------------------------------------
// Response: responses → chat.completions (non-streaming)
// ---------------------------------------------------------------------------

interface ResponsesOutputMessagePart {
  type: string;
  text?: string;
}

interface ResponsesOutputItem {
  type: string;
  role?: string;
  content?: ResponsesOutputMessagePart[];
  // function_call shape:
  call_id?: string;
  name?: string;
  arguments?: string;
  id?: string;
  status?: string;
}

interface ResponsesNonStreamResponse {
  id?: string;
  model?: string;
  output?: ResponsesOutputItem[];
  status?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  incomplete_details?: { reason?: string } | null;
}

const finishReasonFromResponses = (
  res: ResponsesNonStreamResponse,
  hasToolCalls: boolean,
): string => {
  if (hasToolCalls) return "tool_calls";
  const reason = res.incomplete_details?.reason;
  if (reason === "max_output_tokens") return "length";
  if (reason === "content_filter") return "content_filter";
  return "stop";
};

export const responsesToChatNonStream = (
  upstream: ResponsesNonStreamResponse,
): Record<string, unknown> => {
  const items = upstream.output ?? [];
  let text = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  for (const item of items) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && (part.type === "output_text" || part.type === "text")) {
          text += part.text ?? "";
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? `call_${randomUUID()}`,
        type: "function",
        function: {
          name: item.name ?? "",
          arguments: item.arguments ?? "",
        },
      });
    }
  }

  const message: Record<string, unknown> = { role: "assistant" };
  if (text) message.content = text;
  else message.content = null;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = upstream.usage ?? {};

  return {
    id: upstream.id ?? `chatcmpl_${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: upstream.model ?? "",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReasonFromResponses(upstream, toolCalls.length > 0),
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens:
        usage.total_tokens ??
        (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
};

// ---------------------------------------------------------------------------
// Response: responses (SSE) → chat.completions (SSE)
// ---------------------------------------------------------------------------

interface ToolCallState {
  index: number;
  id: string;
  name: string;
  emittedHeader: boolean;
}

/**
 * Convert an OpenAI Responses SSE stream into an OpenAI Chat Completions
 * SSE stream so existing chat-completion clients can consume it.
 */
export const responsesStreamToChatStream = (
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const chunkId = `chatcmpl_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      let buffer = "";
      let model = requestedModel;
      let roleEmitted = false;
      let finishEmitted = false;
      let promptTokens = 0;
      let completionTokens = 0;
      let finishReason: string | null = null;
      // function_call items by output_index
      const toolCalls = new Map<number, ToolCallState>();

      const writeChunk = (delta: Record<string, unknown>, finish: string | null = null): void => {
        const payload = {
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta,
              finish_reason: finish,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const writeUsageChunk = (): void => {
        const payload = {
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const ensureRole = (): void => {
        if (roleEmitted) return;
        roleEmitted = true;
        writeChunk({ role: "assistant", content: "" });
      };

      const handleEvent = (eventType: string, data: Record<string, unknown>): void => {
        switch (eventType) {
          case "response.created":
          case "response.in_progress": {
            const m = (data.response as { model?: string } | undefined)?.model;
            if (m) model = m;
            return;
          }
          case "response.output_item.added": {
            const item = data.item as ResponsesOutputItem | undefined;
            if (item?.type === "function_call") {
              const idx = (data.output_index as number) ?? toolCalls.size;
              const state: ToolCallState = {
                index: toolCalls.size,
                id: item.call_id ?? `call_${randomUUID()}`,
                name: item.name ?? "",
                emittedHeader: false,
              };
              toolCalls.set(idx, state);
              ensureRole();
              writeChunk({
                tool_calls: [
                  {
                    index: state.index,
                    id: state.id,
                    type: "function",
                    function: {
                      name: state.name,
                      arguments: "",
                    },
                  },
                ],
              });
              state.emittedHeader = true;
            }
            return;
          }
          case "response.output_text.delta": {
            const delta = data.delta as string | undefined;
            if (!delta) return;
            ensureRole();
            writeChunk({ content: delta });
            return;
          }
          case "response.function_call_arguments.delta": {
            const idx = data.output_index as number | undefined;
            const delta = data.delta as string | undefined;
            if (idx === undefined || !delta) return;
            const state = toolCalls.get(idx);
            if (!state) return;
            writeChunk({
              tool_calls: [
                {
                  index: state.index,
                  function: { arguments: delta },
                },
              ],
            });
            return;
          }
          case "response.completed": {
            const resp = data.response as ResponsesNonStreamResponse | undefined;
            if (resp?.usage) {
              promptTokens = resp.usage.input_tokens ?? promptTokens;
              completionTokens = resp.usage.output_tokens ?? completionTokens;
            }
            finishReason = toolCalls.size > 0 ? "tool_calls" : "stop";
            return;
          }
          case "response.incomplete": {
            const resp = data.response as ResponsesNonStreamResponse | undefined;
            if (resp?.usage) {
              promptTokens = resp.usage.input_tokens ?? promptTokens;
              completionTokens = resp.usage.output_tokens ?? completionTokens;
            }
            const reason = resp?.incomplete_details?.reason;
            finishReason =
              reason === "max_output_tokens"
                ? "length"
                : reason === "content_filter"
                  ? "content_filter"
                  : "stop";
            return;
          }
          case "response.failed":
          case "response.error": {
            finishReason = "stop";
            return;
          }
          default:
            return;
        }
      };

      const processLine = (line: string, currentEvent: { type: string }): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed.startsWith("event:")) {
          currentEvent.type = trimmed.slice(6).trim();
          return;
        }
        if (!trimmed.startsWith("data:")) return;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(payload);
        } catch {
          return;
        }
        // If event field absent, fall back to `type` field in the payload.
        const t = currentEvent.type || (typeof data.type === "string" ? (data.type as string) : "");
        if (t) handleEvent(t, data);
      };

      const flushBuffer = (final: boolean): void => {
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const currentEvent = { type: "" };
          for (const ln of block.split("\n")) processLine(ln, currentEvent);
        }
        if (final && buffer.length > 0) {
          const currentEvent = { type: "" };
          for (const ln of buffer.split("\n")) processLine(ln, currentEvent);
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

        if (!roleEmitted) {
          ensureRole();
        }

        if (!finishEmitted) {
          finishEmitted = true;
          writeChunk({}, finishReason ?? "stop");
        }
        writeUsageChunk();
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
};
