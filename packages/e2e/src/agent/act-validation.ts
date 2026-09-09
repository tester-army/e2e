/**
 * Input and verdict validation for the act dispatch (spec 02, 16). Pure
 * functions with no dispatch state: everything a step's arguments and an
 * executor's verdict must satisfy before the harness trusts them.
 */

import { ConfigurationError, TestError } from '../internal/errors.ts';
import { validateJsonValue } from '../internal/json-value.ts';
import { isSecret } from '../locator/screen.ts';
import type { ActOptions, AgentErrorCode, AgentParams, JsonValue, Secret } from '../types.ts';
import { AgentError, CATEGORY_BY_CODE } from './error.ts';
import { BLOCKABLE_CODES, type StepVerdict } from './executor.ts';

const MAX_SUMMARY_CHARS = 2_000;

/** Spec 02: instructions are 1 through 8 KiB UTF-8 after NFC. */
const MAX_INSTRUCTION_BYTES = 8_192;

/** Spec 02: canonical non-secret parameters are capped at 64 KiB, 32 levels. */
const MAX_PARAMS_BYTES = 65_536;
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

/**
 * The `act` type has no `schema` or `vision`; a caller outside the type
 * checker who passes one still fails loudly instead of being silently ignored.
 */
export function rejectUnsupportedActOptions(options: ActOptions | undefined): void {
  if (options === undefined) return;
  const loose = options as { readonly schema?: unknown; readonly vision?: unknown };
  const unsupported = (name: string): never => {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      `agent.act ${name} is not part of this milestone`,
    );
  };
  if (loose.schema !== undefined) unsupported('structured output (options.schema)');
  if (loose.vision !== undefined) unsupported('vision evidence (options.vision)');
}

/**
 * Validates parameters and returns an inert, secret-free snapshot plus the
 * declared secrets. A `Secret` value is projected to
 * `{ kind: 'secret', name, purpose }` — its plaintext never enters the
 * snapshot, the prompt, or any log — and is fillable only through
 * `actions.typeSecret`. The JSON round-trip is deliberate: it bounds the
 * canonical size (spec 02) and freezes what the executor sees, so a getter
 * or proxy cannot change values — or run code — during later serialization.
 */
export function validateParams(params: AgentParams | undefined): {
  projected: Readonly<Record<string, JsonValue>> | undefined;
  secrets: ReadonlyMap<string, Secret>;
} {
  if (params === undefined) return { projected: undefined, secrets: new Map() };
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new TestError('INVALID_ARGUMENT', 'agent.act params must be a plain object');
  }
  const secrets = new Map<string, Secret>();
  const projectedRaw = projectSecrets(params, secrets, new Set());
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
    projected: JSON.parse(canonical) as Readonly<Record<string, JsonValue>>,
    secrets,
  };
}

/** Replaces every Secret leaf with its placeholder, collecting the originals. */
function projectSecrets(value: unknown, secrets: Map<string, Secret>, seen: Set<unknown>): unknown {
  if (isSecret(value)) {
    secrets.set(value.name, value);
    return { kind: 'secret', name: value.name, purpose: value.purpose };
  }
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) {
    throw new TestError('INVALID_ARGUMENT', 'agent.act params contains a cycle');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => projectSecrets(entry, secrets, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, projectSecrets(entry, secrets, seen)]),
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
