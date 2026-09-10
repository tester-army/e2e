/**
 * Recognizes a context-window overflow in a provider failure. Providers say
 * it in as many ways as there are providers, and a gateway forwards their
 * words; the patterns below are the ones seen in the wild (ported from the
 * pi agent harness, which collected them across twenty providers), plus the
 * HTTP 413 some of them answer with instead of a message.
 *
 * The runner reacts to an overflow differently from any other provider
 * failure: the request was too big, so a smaller request can still succeed,
 * where a 5xx or a rate limit needs only time.
 */

const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i, // Anthropic
  /request_too_large/i, // Anthropic (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies
  /input token count.*exceeds the maximum/i, // Google
  /maximum prompt length is \d+/i, // xAI
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4
  /model_context_window_exceeded/i, // z.ai
  /prompt too long; exceeded (?:max )?context length/i, // Ollama
  /range of input length should be/i, // DashScope / Qwen
  /context[_ ]length[_ ]exceeded/i, // generic
  /too many tokens/i, // generic
  /token limit exceeded/i, // generic
];

/** Failures that mention tokens without being an overflow: throttling and its cousins. */
const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /throttl/i, // Amazon Bedrock: "ThrottlingException: Too many tokens, please wait…"
  /service unavailable/i,
  /rate limit/i,
  /too many requests/i,
];

/** Longest cause chain walked; a wrapped error rarely nests deeper. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Whether a provider failure says the request exceeded the model's context
 * window. Reads the message, the HTTP status, and the raw response body of
 * the error and of everything it wraps (`cause`, or the last attempt of a
 * spent retry chain), so a gateway or retry wrapper does not hide the
 * provider's words.
 */
export function isContextOverflow(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (describesOverflow(current)) return true;
    if (typeof current !== 'object') return false;
    const wrapper = current as { cause?: unknown; lastError?: unknown };
    current = wrapper.cause ?? wrapper.lastError;
  }
  return false;
}

/**
 * One error object, read on its own. HTTP 413 is an overflow whatever the
 * text says. A text field counts when it matches an overflow pattern and no
 * throttling pattern; the veto is per field, so a wrapper's "rate limit"
 * message cannot hide the provider's "prompt is too long" in the body.
 */
function describesOverflow(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { message?: unknown; statusCode?: unknown; status?: unknown; responseBody?: unknown };
  if ((record.statusCode ?? record.status) === 413) return true;
  return [record.message, record.responseBody].some(
    (text) =>
      typeof text === 'string' &&
      OVERFLOW_PATTERNS.some((pattern) => pattern.test(text)) &&
      !NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text)),
  );
}
