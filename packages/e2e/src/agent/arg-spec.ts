/**
 * The argument vocabulary one `agent-tool-1` action is declared in.
 *
 * A spec says three things about one argument at once: how it is declared to the
 * provider, how it reads in the request text, and how a response value becomes a
 * typed argument. They are one object because a schema, a prompt line, and a
 * parser that disagree produce a repair round every time the model believes the
 * one that is wrong.
 *
 * Nothing here knows what any action is. `action-space.ts` owns the vocabulary;
 * this file owns the grammar it is written in.
 */

import type { JSONSchema7 } from 'ai';
import type { SemanticNode } from '../driver/index.ts';
import { boundedString } from '../internal/json.ts';
import type { AgentObservation } from './observation.ts';
import type { ProtocolValidation } from './protocol.ts';

/**
 * One argument of one action: how it is declared to the provider, how it reads
 * in the prompt, and how a response value becomes a typed argument.
 *
 * An optional argument is an `ArgSpec<T | undefined>` whose `parse` accepts
 * absence, so the parsed type follows from the spec rather than from a second
 * flag the type system would have to reconcile.
 */
export interface ArgSpec<T> {
  readonly schema: JSONSchema7;
  /** How this argument is described in the request text. */
  readonly hint: string;
  readonly required: boolean;
  parse(value: unknown, observation: AgentObservation): ProtocolValidation<T>;
}

const REF_MAX_LENGTH = 256;

/** Bound on the model's own prose, per the agent-tool-1 schema. */
export const EXPLANATION_MAX_LENGTH = 8192;

export function ok<T>(value: T): ProtocolValidation<T> {
  return { ok: true, value };
}

export function fail(issue: string): { ok: false; issue: string } {
  return { ok: false, issue };
}

/** Makes any spec optional, accepting absence as `undefined`. */
export function optional<T>(spec: ArgSpec<T>): ArgSpec<T | undefined> {
  return {
    ...spec,
    required: false,
    hint: `${spec.hint} (optional)`,
    parse: (value, observation) =>
      value === undefined ? ok(undefined) : spec.parse(value, observation),
  };
}

/**
 * A node of the current observation.
 *
 * Validating the reference here rather than at dispatch is what stops a model
 * from naming something it was never shown: an invented id or a stale revision
 * is invalid output worth one repair round, and the alternative — acting on
 * whatever node happens to carry that id now — acts on the wrong thing.
 */
export const node = (purpose: string): ArgSpec<SemanticNode> => ({
  required: true,
  hint: `"target": { "id": <the node id exactly as printed after "#">, "revision": <observation revision> } — ${purpose}`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: REF_MAX_LENGTH },
      revision: { type: 'string', minLength: 1, maxLength: REF_MAX_LENGTH },
    },
  },
  parse: (value, observation) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail('target must be an { id, revision } node reference');
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'id' && key !== 'revision') return fail(`target has no "${key}" field`);
    }
    const id = boundedString(record['id'], 1, REF_MAX_LENGTH);
    const revision = boundedString(record['revision'], 1, REF_MAX_LENGTH);
    if (id === undefined || revision === undefined) return fail('target id/revision are invalid');
    if (revision !== observation.revision) {
      return fail(
        `target revision "${revision}" is stale; the current observation is ` +
          `"${observation.revision}". Quote the revision printed with the observation you are reading.`,
      );
    }
    const found = observation.nodes.get(id);
    if (found === undefined) {
      return fail(`no node #${id} exists in observation "${observation.revision}"`);
    }
    return ok(found);
  },
});

export const text = (name: string, purpose: string, maxLength: number): ArgSpec<string> => ({
  required: true,
  hint: `"${name}": <${purpose}>`,
  schema: { type: 'string', maxLength },
  parse: (value) => {
    const parsed = boundedString(value, 0, maxLength);
    return parsed === undefined
      ? fail(`${name} must be a string of at most ${maxLength} characters`)
      : ok(parsed);
  },
});

export const shortText = (name: string, purpose: string, maxLength: number): ArgSpec<string> => ({
  required: true,
  hint: `"${name}": <${purpose}>`,
  schema: { type: 'string', minLength: 1, maxLength },
  parse: (value) => {
    const parsed = boundedString(value, 1, maxLength);
    return parsed === undefined
      ? fail(`${name} must be a non-empty string of at most ${maxLength} characters`)
      : ok(parsed);
  },
});

export const oneOf = <T extends string>(name: string, values: readonly T[]): ArgSpec<T> => ({
  required: true,
  hint: `"${name}": ${values.map((value) => `"${value}"`).join(' | ')}`,
  schema: { type: 'string', enum: [...values] },
  parse: (value) =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
      ? ok(value as T)
      : fail(`${name} must be one of: ${values.join(', ')}`),
});

export const integer = (name: string, min: number, max: number): ArgSpec<number> => ({
  required: true,
  hint: `"${name}": <integer ${min}-${max}>`,
  schema: { type: 'integer', minimum: min, maximum: max },
  parse: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
      ? ok(value)
      : fail(`${name} must be an integer from ${min} through ${max}`),
});

export const anyJson = (name: string, purpose: string): ArgSpec<unknown> => ({
  required: false,
  hint: `"${name}": <${purpose}>`,
  schema: {},
  parse: (value) => ok(value),
});
