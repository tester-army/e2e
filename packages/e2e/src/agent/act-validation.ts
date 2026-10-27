/**
 * Input and verdict validation for the act dispatch (spec 02, 16). Pure
 * functions with no dispatch state: everything a step's arguments and an
 * executor's verdict must satisfy before the harness trusts them.
 */

import { ConfigurationError, TestError } from '../internal/errors.ts';
import { validateJsonValue } from '../internal/json-value.ts';
import { paramPointer, type ParamTemplate } from '../cache/template.ts';
import { isSecret } from '../secrets.ts';
import { isUnique } from '../params.ts';
import type { ActOptions, AgentErrorCode, AgentParams, JsonValue, Secret } from '../types.ts';
import { AgentError, CATEGORY_BY_CODE } from './error.ts';
import { BLOCKABLE_CODES, type StepVerdict } from './executor.ts';

const MAX_SUMMARY_CHARS = 2_000;

/** Spec 02: instructions are 1 through 8 KiB UTF-8 after NFC. */
const MAX_INSTRUCTION_BYTES = 8_192;

/** Spec 02: canonical non-secret parameters are capped at 64 KiB, 32 levels. */
export const MAX_PARAMS_BYTES = 65_536;
const MAX_PARAMS_DEPTH = 32;

/** Normalizes and bounds the instruction per spec 02. */
export function validateInstruction(instruction: string, api: string): string {
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    throw new TestError('INVALID_ARGUMENT', `${api} requires a non-empty instruction`);
  }
  const normalized = instruction.normalize('NFC');
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (bytes > MAX_INSTRUCTION_BYTES) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `${api} instruction is ${bytes} bytes; the maximum is ${MAX_INSTRUCTION_BYTES}`,
    );
  }
  return normalized;
}

const ACT_OPTION_KEYS: ReadonlySet<string> = new Set(['params', 'timeout', 'maxSteps', 'maxModelCalls', 'agent', 'onAction', 'onBeforeAction']);

/**
 * The `act` type has no `schema` and no `vision`, and no key outside
 * `ActOptions`; a caller outside the type checker who passes one still fails
 * loudly instead of being silently ignored. The pre-0.8 shapes land here too: `act(instruction,
 * params)` arrives as an options bag of the caller's own keys, and
 * `act(instruction, params, options)` as a third argument.
 */
export function validateActOptions(options: ActOptions | undefined, extraArguments: number): void {
  if (extraArguments > 0) {
    throw new TestError(
      'INVALID_ARGUMENT',
      'agent.act takes two arguments: act(instruction, { params, timeout, maxSteps, maxModelCalls })',
    );
  }
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TestError('INVALID_ARGUMENT', 'agent.act options must be a plain object');
  }
  const loose = options as { readonly schema?: unknown; readonly vision?: unknown };
  if (loose.schema !== undefined) {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      'agent.act structured output (options.schema) is not part of this milestone',
    );
  }
  if (loose.vision !== undefined) {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      'agent.act takes no vision option: the model works from the tree and asks for a screenshot itself when the tree lacks what it needs; vision is a judgment option (assert, waitFor, extract)',
    );
  }
  const onBeforeAction: unknown = options.onBeforeAction;
  if (onBeforeAction !== undefined && typeof onBeforeAction !== 'function') {
    throw new TestError('INVALID_ARGUMENT', 'agent.act options.onBeforeAction must be a function');
  }
  const onAction: unknown = options.onAction;
  if (onAction !== undefined && typeof onAction !== 'function') {
    throw new TestError('INVALID_ARGUMENT', 'agent.act options.onAction must be a function');
  }
  const unknown = Object.keys(options).filter((key) => !ACT_OPTION_KEYS.has(key));
  if (unknown.length > 0) {
    const listed = unknown.map((key) => JSON.stringify(key)).join(', ');
    throw new TestError(
      'INVALID_ARGUMENT',
      `agent.act options has no ${unknown.length === 1 ? 'key' : 'keys'} ${listed}; the values an instruction refers to go under params: act(instruction, { params: { ${unknown.join(', ')} } })`,
    );
  }
}

/**
 * Validates parameters and returns an inert, secret-free snapshot plus what
 * the walk found in it: the declared secrets and the `unique()` values. A
 * `Secret` is projected to `{ kind: 'secret', name, purpose }` — its
 * plaintext never enters the snapshot, the prompt, or any log — and is
 * fillable only through `actions.typeSecret`. A `Unique` is projected to its
 * string, so the model and the executor see a plain value, and is listed by
 * JSON Pointer for the trace cache to template. The JSON round-trip is
 * deliberate: it bounds the canonical size (spec 02) and freezes what the
 * executor sees, so a getter or proxy cannot change values — or run code —
 * during later serialization.
 */
export function validateParams(params: AgentParams | undefined): {
  projected: Readonly<Record<string, JsonValue>> | undefined;
  secrets: ReadonlyMap<string, Secret>;
  templates: readonly ParamTemplate[];
} {
  if (params === undefined) return { projected: undefined, secrets: new Map(), templates: [] };
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new TestError('INVALID_ARGUMENT', 'agent.act params must be a plain object');
  }
  const found: FoundParams = { secrets: new Map(), templates: [] };
  const projectedRaw = projectParams(params, '', found, new Set());
  validateJsonValue(projectedRaw, 'agent.act params', { maxDepth: MAX_PARAMS_DEPTH });
  const canonical = JSON.stringify(projectedRaw);
  const bytes = new TextEncoder().encode(canonical).byteLength;
  if (bytes > MAX_PARAMS_BYTES) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `agent.act params are ${bytes} canonical bytes; the maximum is ${MAX_PARAMS_BYTES}`,
    );
  }
  return {
    // oxlint-disable-next-line e2e/no-unchecked-json -- canonical is this function's own JSON.stringify of a plain object validateJsonValue just checked
    projected: JSON.parse(canonical) as Readonly<Record<string, JsonValue>>,
    secrets: found.secrets,
    templates: found.templates,
  };
}

/**
 * Projected params with `redact` applied to every string in them, object
 * keys included, and their `unique()` templates moved with their leaves: a
 * template's pointer follows the redacted keys and its value is redacted as
 * the leaf is, so the trace cache slots what the params hold.
 */
export function redactParams(
  params: Readonly<Record<string, JsonValue>>,
  templates: readonly ParamTemplate[],
  redact: (text: string) => string,
): { params: Readonly<Record<string, JsonValue>>; templates: readonly ParamTemplate[] } {
  const pointers = new Map<string, string>();
  const redacted = redactJson(params, redact, { from: '', to: '' }, pointers) as Readonly<Record<string, JsonValue>>;
  return {
    params: redacted,
    templates: templates.map((template) => ({
      pointer: pointers.get(template.pointer) ?? template.pointer,
      value: redact(template.value),
    })),
  };
}

/**
 * `value` with `redact` applied to every string in it, object keys included.
 * Records in `pointers` where each node's pointer (`at.from`) lands once its
 * keys are redacted (`at.to`). Two keys of one object that redact alike would
 * leave one value standing for both, so that is `INVALID_ARGUMENT`.
 */
function redactJson(
  value: JsonValue,
  redact: (text: string) => string,
  at: { readonly from: string; readonly to: string },
  pointers: Map<string, string>,
): JsonValue {
  pointers.set(at.from, at.to);
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      redactJson(entry, redact, { from: paramPointer(at.from, index), to: paramPointer(at.to, index) }, pointers),
    );
  }
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const clean = redact(key);
    if (Object.hasOwn(out, clean)) {
      throw new TestError(
        'INVALID_ARGUMENT',
        `agent.act params has two keys that read ${JSON.stringify(clean)} once secret values are redacted; a key cannot be told apart by a secret`,
      );
    }
    // Defined, not assigned, so a `__proto__` key stays an own property.
    Object.defineProperty(out, clean, {
      value: redactJson(entry, redact, { from: paramPointer(at.from, key), to: paramPointer(at.to, clean) }, pointers),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** The marked leaves one walk of the params found. */
interface FoundParams {
  readonly secrets: Map<string, Secret>;
  readonly templates: ParamTemplate[];
}

/** Replaces every Secret leaf with its placeholder and every Unique leaf with its value, collecting both. */
function projectParams(value: unknown, pointer: string, found: FoundParams, seen: Set<unknown>): unknown {
  if (isSecret(value)) {
    found.secrets.set(value.name, value);
    return { kind: 'secret', name: value.name, purpose: value.purpose };
  }
  if (isUnique(value)) {
    found.templates.push({ pointer, value: value.value });
    return value.value;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) {
    throw new TestError('INVALID_ARGUMENT', 'agent.act params contains a cycle');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) => projectParams(entry, paramPointer(pointer, index), found, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, projectParams(entry, paramPointer(pointer, key), found, seen)]),
  );
}

/** Closes the verdict grammar: the executor cannot invent statuses or codes. */
export function validateVerdict(verdict: unknown, executorName: string): StepVerdict {
  const invalid = (issue: string): never => {
    throw new AgentError(
      'MODEL_OUTPUT_INVALID',
      `executor "${executorName}" returned an invalid verdict: ${issue}`,
    );
  };
  if (typeof verdict !== 'object' || verdict === null) return invalid('not an object');
  const candidate = verdict as Record<string, unknown>;
  const status = candidate['status'];
  if (status !== 'passed' && status !== 'failed' && status !== 'blocked') {
    return invalid(`status must be passed, failed, or blocked, got ${JSON.stringify(status)}`);
  }
  const summary = candidate['summary'];
  if (typeof summary !== 'string' || summary.trim() === '') {
    return invalid('summary must be a non-empty string');
  }
  const errorCode = candidate['errorCode'];
  if (errorCode !== undefined) {
    if (typeof errorCode !== 'string' || !(errorCode in CATEGORY_BY_CODE)) {
      return invalid(`unknown errorCode ${JSON.stringify(errorCode)}`);
    }
  }
  const code = errorCode as AgentErrorCode | undefined;
  if (status === 'passed' && code !== undefined) {
    return invalid('a passed verdict cannot carry an errorCode');
  }
  if (status === 'blocked' && (code === undefined || !BLOCKABLE_CODES.has(code))) {
    return invalid(
      `blocked requires a blockable errorCode (one of ${[...BLOCKABLE_CODES].join(', ')})`,
    );
  }
  return {
    status,
    summary: summary.trim().slice(0, MAX_SUMMARY_CHARS),
    ...(code === undefined ? {} : { errorCode: code }),
  };
}
