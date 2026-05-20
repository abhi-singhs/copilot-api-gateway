/**
 * Translate an Anthropic /v1/messages request body into an OpenAI
 * /v1/chat/completions request body suitable for forwarding to GitHub
 * Copilot's chat-completions edge.
 */

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: unknown }
  | { type: "image"; source: AnthropicImageSource; cache_control?: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
      is_error?: boolean;
      cache_control?: unknown;
    }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "document"; source: unknown; cache_control?: unknown };

export interface AnthropicImageSource {
  type: "base64" | "url";
  media_type?: string;
  data?: string;
  url?: string;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string; cache_control?: unknown }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?:
    | { type: "auto" | "any" | "none" }
    | { type: "tool"; name: string };
  thinking?: unknown;
  metadata?: Record<string, unknown>;
  service_tier?: string;
  // Anthropic also accepts a top-level `anthropic_version`; ignored upstream.
  [k: string]: unknown;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

const systemToString = (
  system: AnthropicRequest["system"],
): string | undefined => {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n");
};

const imageBlockToOpenAI = (
  block: Extract<AnthropicContentBlock, { type: "image" }>,
): Record<string, unknown> | null => {
  const { source } = block;
  if (!source) return null;
  if (source.type === "url" && source.url) {
    return { type: "image_url", image_url: { url: source.url } };
  }
  if (source.type === "base64" && source.data) {
    const mt = source.media_type ?? "image/png";
    return {
      type: "image_url",
      image_url: { url: `data:${mt};base64,${source.data}` },
    };
  }
  return null;
};

const userContentToOpenAI = (
  content: string | AnthropicContentBlock[],
): { messages: OpenAIMessage[] } => {
  if (typeof content === "string") {
    return { messages: [{ role: "user", content }] };
  }

  // Tool results must be emitted as separate role:"tool" messages, but each
  // such message must come AFTER the assistant message containing the
  // matching tool_calls. They cannot be interleaved with arbitrary user
  // content blocks — so we emit tool_result blocks as standalone tool
  // messages and the remaining text/image blocks as a regular user message.
  const toolMsgs: OpenAIMessage[] = [];
  const otherParts: Array<Record<string, unknown>> = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        if (block.text) otherParts.push({ type: "text", text: block.text });
        break;
      case "image": {
        const part = imageBlockToOpenAI(block);
        if (part) otherParts.push(part);
        break;
      }
      case "tool_result": {
        const resultText =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((p) => {
                    if (!p || typeof p !== "object") return "";
                    if (p.type === "text") return (p as { text: string }).text ?? "";
                    return "";
                  })
                  .join("")
              : "";
        toolMsgs.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.is_error
            ? `[ERROR] ${resultText}`
            : resultText,
        });
        break;
      }
      case "document":
      case "thinking":
      case "redacted_thinking":
        // dropped
        break;
      default:
        break;
    }
  }

  const out: OpenAIMessage[] = [];
  // Per OpenAI spec, tool messages must immediately follow the assistant
  // message that requested them. The caller (translateRequest) iterates the
  // Anthropic message list in order, so emitting tool messages FIRST in the
  // current "user" group preserves that adjacency.
  out.push(...toolMsgs);
  if (otherParts.length > 0) {
    const onlyText =
      otherParts.length === 1 &&
      otherParts[0] &&
      otherParts[0].type === "text";
    out.push({
      role: "user",
      content: onlyText
        ? (otherParts[0] as { text: string }).text
        : otherParts,
    });
  }
  return { messages: out };
};

const assistantContentToOpenAI = (
  content: string | AnthropicContentBlock[],
): OpenAIMessage => {
  if (typeof content === "string") {
    return { role: "assistant", content };
  }
  let text = "";
  const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      text += block.text ?? "";
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // thinking/redacted_thinking dropped
  }
  const msg: OpenAIMessage = { role: "assistant" };
  if (text) msg.content = text;
  else msg.content = null;
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return msg;
};

const toolChoiceToOpenAI = (
  tc: AnthropicRequest["tool_choice"],
): unknown => {
  if (!tc) return undefined;
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: tc.name } };
  }
};

export interface TranslatedRequest {
  body: Record<string, unknown>;
  stream: boolean;
}

export const translateAnthropicRequest = (
  req: AnthropicRequest,
): TranslatedRequest => {
  const messages: OpenAIMessage[] = [];

  const sys = systemToString(req.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const m of req.messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") {
      messages.push(assistantContentToOpenAI(m.content));
    } else {
      const { messages: msgs } = userContentToOpenAI(m.content);
      messages.push(...msgs);
    }
  }

  const out: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: req.stream === true,
  };

  if (typeof req.max_tokens === "number") out.max_tokens = req.max_tokens;
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length > 0) {
    out.stop = req.stop_sequences;
  }

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }

  const tc = toolChoiceToOpenAI(req.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;

  if (req.stream === true) {
    out.stream_options = { include_usage: true };
  }

  return { body: out, stream: req.stream === true };
};
