/**
 * Recognizes a provider refusing a forced tool choice. The act loop asks for
 * a tool call on every turn (`toolChoice: 'required'`) and names
 * `complete_step` on the final ones; some models reject that request shape
 * outright (Anthropic's Claude Fable 5.1 answers HTTP 400 with
 * `tool_choice: type "tool" and "any" are not supported for this model.`),
 * and a gateway forwards the provider's words.
 *
 * The loop reacts to this refusal differently from any other provider
 * failure: the same request with `toolChoice: 'auto'` and an instruction to
 * answer with tool calls can still succeed, where a 5xx needs only time.
 */

const FORCED_CHOICE_PATTERNS: readonly RegExp[] = [
  /tool_choice.*not supported/i, // Anthropic
  /tool_choice.*(?:unsupported|is not allowed|cannot be)/i, // OpenAI-compatible proxies
  /(?:forced|required) tool (?:choice|call|use).*not supported/i, // generic
  /does not support (?:forced|required) tool/i, // generic
];

/** Longest cause chain walked; a wrapped error rarely nests deeper. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Whether a provider failure says the model does not accept a forced tool
 * choice. Reads the message and the raw response body of the error and of
 * everything it wraps (`cause`, or the last attempt of a spent retry chain).
 * Only a 4xx counts: a gateway or proxy that fails for its own reasons while
 * quoting the request never reads as a model limitation.
 */
export function isForcedToolChoiceRejected(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (describesRejection(current)) return true;
    if (typeof current !== 'object') return false;
    const wrapper = current as { cause?: unknown; lastError?: unknown };
    current = wrapper.cause ?? wrapper.lastError;
  }
  return false;
}

function describesRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { message?: unknown; statusCode?: unknown; status?: unknown; responseBody?: unknown };
  const status = record.statusCode ?? record.status;
  if (typeof status === 'number' && (status < 400 || status >= 500)) return false;
  return [record.message, record.responseBody].some(
    (text) => typeof text === 'string' && FORCED_CHOICE_PATTERNS.some((pattern) => pattern.test(text)),
  );
}
