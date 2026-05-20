import type { Logger } from "./logger.js";

const MAX_PREVIEW = 100_000;

const preview = (s: string): string =>
  s.length > MAX_PREVIEW ? `${s.slice(0, MAX_PREVIEW)}\n…[truncated ${s.length - MAX_PREVIEW} bytes]` : s;

export const logBody = (
  log: Logger,
  label: string,
  body: unknown,
): void => {
  let s: string;
  try {
    s = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  } catch {
    s = "[unserialisable]";
  }
  log.info(`${label}\n${preview(s)}`);
};

/**
 * Wrap an upstream `Response` so the body is teed into a log line while
 * still being forwarded to the client. Works for both streaming and
 * non-streaming responses.
 *
 * If `enabled` is false, the original response is returned untouched.
 */
export const tapResponse = (
  res: Response,
  log: Logger,
  label: string,
  enabled: boolean,
): Response => {
  if (!enabled || !res.body) return res;

  const [a, b] = res.body.tee();
  void (async () => {
    const reader = b.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
      }
      log.info(`${label} status=${res.status} bytes=${acc.length}\n${preview(acc)}`);
    } catch (err) {
      log.warn(`${label} tap error: ${(err as Error).message}`);
    }
  })();

  return new Response(a, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
};

/**
 * Wrap a `ReadableStream` (e.g. one produced by our own translators)
 * so its contents are also logged once it finishes.
 */
export const tapStream = (
  stream: ReadableStream<Uint8Array>,
  log: Logger,
  label: string,
  enabled: boolean,
): ReadableStream<Uint8Array> => {
  if (!enabled) return stream;

  const [a, b] = stream.tee();
  void (async () => {
    const reader = b.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
      }
      log.info(`${label} bytes=${acc.length}\n${preview(acc)}`);
    } catch (err) {
      log.warn(`${label} tap error: ${(err as Error).message}`);
    }
  })();
  return a;
};
