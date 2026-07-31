/**
 * Closed `agent-protocol-1` response grammars. Mirrors
 * spec/schema/agent-locate-v1.schema.json and agent-judgment-v1.schema.json;
 * the spec files win on any divergence. The planning tier's `agent-tool-1`
 * grammar is derived from the action space in `action-space.ts`.
 *
 * Validation is runner-owned: a response that does not match exactly is a
 * policy error before any driver dispatch (14-security.md).
 */

import type { JSONSchema7 } from 'ai';

/** A node of the observation the response quotes. */
export interface LocateNodeTarget {
  readonly id: string;
  readonly revision: string;
}

/**
 * A point in the attached screenshot, in CSS pixels. Offered only to vision
 * calls, and only ever data: the runner validates it against the viewport and
 * hit-tests it before anything is dispatched.
 */
export interface LocatePointTarget {
  readonly point: { readonly x: number; readonly y: number };
  readonly revision: string;
}

export type LocateTarget = LocateNodeTarget | LocatePointTarget;

export interface LocateResponse {
  readonly protocolVersion: 'agent-locate-1';
  /** Null is an explicit, valid "nothing in the observation matches". */
  readonly target: LocateTarget | null;
  /** Why the node was selected, or why no node matches. Untrusted prose. */
  readonly explanation: string;
  /**
   * How the instruction picked the node out, as the model reports it.
   *
   * `content` means by what the node says — "the Save button". `position` means
   * by where it sits — "the first result". `unreported` means the model did not
   * say, and is deliberately distinct from `content`: a derived locator is
   * always content-addressed, so replaying one for a positional instruction
   * resolves whatever now carries that content rather than whatever now sits in
   * that position. That is a wrong answer, and the cache is never allowed to
   * produce one. Only `content` is recordable, so a model that omits the field
   * costs a model locate per run and can never cause a wrong action.
   *
   * There is no structural substitute for this report. Derived queries never
   * contain an index node (`deriveQueries`), so a locator's shape cannot reveal
   * whether the instruction behind it was positional.
   */
  readonly targeting: 'content' | 'position' | 'unreported';
}

/** True when a validated target names an observation node rather than a point. */
export function isNodeTarget(target: LocateTarget): target is LocateNodeTarget {
  return 'id' in target;
}

export interface JudgmentResponse {
  readonly protocolVersion: 'agent-judgment-1';
  readonly result: boolean;
  readonly explanation: string;
}

export type ProtocolValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string };

const REF_MAX_LENGTH = 256;
const EXPLANATION_MAX_LENGTH = 8192;

/** Absolute coordinate ceiling; the viewport is the real bound (locate.ts). */
const COORDINATE_MAX = 100_000;

const NODE_TARGET_SCHEMA: JSONSchema7 = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'revision'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: REF_MAX_LENGTH },
    revision: { type: 'string', minLength: 1, maxLength: REF_MAX_LENGTH },
  },
};

const POINT_TARGET_SCHEMA: JSONSchema7 = {
  type: 'object',
  additionalProperties: false,
  required: ['point', 'revision'],
  properties: {
    point: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: {
        x: { type: 'number', minimum: 0, maximum: COORDINATE_MAX },
        y: { type: 'number', minimum: 0, maximum: COORDINATE_MAX },
      },
    },
    revision: { type: 'string', minLength: 1, maxLength: REF_MAX_LENGTH },
  },
};

/**
 * The structured-output schema one locate call is made under.
 *
 * `positional` is declared and required here even though the protocol tolerates
 * its absence. The two are not in tension: `additionalProperties` is false, so a
 * field this schema does not declare is one a strict provider forbids the model
 * from sending — asking for it in the prompt alone got it silently stripped from
 * every response, which left every locate unrecordable and the cache
 * permanently cold. Requiring it is how the runner actually asks. The
 * validator's tolerance stays a backstop for a provider that does not enforce
 * schemas, not the expected path.
 */
function locateSchema(targets: readonly JSONSchema7[]): JSONSchema7 {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['protocolVersion', 'target', 'explanation', 'positional'],
    properties: {
      // Single-value enum rather than const: strict structured-output modes
      // across providers accept enum but not const.
      protocolVersion: { type: 'string', enum: ['agent-locate-1'] },
      target: { anyOf: [...targets, { type: 'null' }] },
      explanation: { type: 'string', maxLength: EXPLANATION_MAX_LENGTH },
      positional: { type: 'boolean' },
    },
  };
}

/**
 * What a locate response is allowed to name, decided by the evidence the call
 * carries and by what the calling method can act on.
 *
 * These are separate grammars rather than one permissive grammar with runtime
 * checks, so a call can never be answered in terms it did not offer: a
 * coordinate to a method that needs a node reference, or a node identifier to a
 * call that was never shown the tree those identifiers come from.
 */
export type LocateGrammar =
  /** The tree is the only evidence, or the caller cannot act on a coordinate. */
  | 'node'
  /** Both are available; a node is preferred and a point is the escape hatch. */
  | 'nodeOrPoint'
  /** No tree reached the model, so there is nothing to name but a point. */
  | 'point';

export const LOCATE_SCHEMAS: Readonly<Record<LocateGrammar, JSONSchema7>> = {
  node: locateSchema([NODE_TARGET_SCHEMA]),
  nodeOrPoint: locateSchema([NODE_TARGET_SCHEMA, POINT_TARGET_SCHEMA]),
  point: locateSchema([POINT_TARGET_SCHEMA]),
};

export const JUDGMENT_SCHEMA: JSONSchema7 = {
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'result', 'explanation'],
  properties: {
    protocolVersion: { type: 'string', enum: ['agent-judgment-1'] },
    result: { type: 'boolean' },
    explanation: { type: 'string', maxLength: EXPLANATION_MAX_LENGTH },
  },
};

/**
 * Validates one locate response against the grammar the call was made under. An
 * answer outside that grammar is invalid output worth one repair round, never a
 * silently accepted target.
 */
export function validateLocateResponse(
  value: unknown,
  grammar: LocateGrammar = 'node',
): ProtocolValidation<LocateResponse> {
  const record = asClosedRecord(value, [
    'protocolVersion',
    'target',
    'explanation',
    'positional',
  ]);
  if (record === null) return fail('response is not an agent-locate-1 object');
  if (record['protocolVersion'] !== 'agent-locate-1') return fail('unknown protocolVersion');
  const explanation = asBoundedString(record['explanation'], 0, EXPLANATION_MAX_LENGTH);
  if (explanation === null) return fail('explanation must be a bounded string');
  // Absence is its own answer rather than a default, so silence can never be
  // read as the model asserting the recordable case.
  const reported = record['positional'];
  if (reported !== undefined && typeof reported !== 'boolean') {
    return fail('positional must be a boolean when present');
  }
  const targeting: LocateResponse['targeting'] =
    reported === undefined ? 'unreported' : reported ? 'position' : 'content';
  if (record['target'] === null) {
    return {
      ok: true,
      value: { protocolVersion: 'agent-locate-1', target: null, explanation, targeting },
    };
  }
  const target = validateTarget(record['target'], grammar);
  if (!target.ok) return target;
  return {
    ok: true,
    value: { protocolVersion: 'agent-locate-1', target: target.value, explanation, targeting },
  };
}

/** What each grammar says a target may be, for its own rejection message. */
const TARGET_SHAPES: Readonly<Record<LocateGrammar, string>> = {
  node: 'target is not a node reference or null',
  nodeOrPoint: 'target is not a node reference, a point, or null',
  point: 'target is not a point or null',
};

function validateTarget(
  value: unknown,
  grammar: LocateGrammar,
): ProtocolValidation<LocateTarget> {
  const node = asClosedRecord(value, ['id', 'revision']);
  if (node !== null) {
    if (grammar === 'point') {
      return fail(
        'no observation was attached, so there are no node identifiers to name; ' +
          'answer with a point in the screenshot',
      );
    }
    const id = asBoundedString(node['id'], 1, REF_MAX_LENGTH);
    const revision = asBoundedString(node['revision'], 1, REF_MAX_LENGTH);
    if (id === null || revision === null) return fail('target id/revision are invalid');
    return { ok: true, value: { id, revision } };
  }
  const pointTarget = asClosedRecord(value, ['point', 'revision']);
  if (pointTarget === null) return fail(TARGET_SHAPES[grammar]);
  if (grammar === 'node') {
    return fail('point targets require a vision call; select a node from the observation');
  }
  const revision = asBoundedString(pointTarget['revision'], 1, REF_MAX_LENGTH);
  if (revision === null) return fail('target revision is invalid');
  const point = asClosedRecord(pointTarget['point'], ['x', 'y']);
  if (point === null) return fail('target point must be an { x, y } object');
  const x = asCoordinate(point['x']);
  const y = asCoordinate(point['y']);
  if (x === null || y === null) {
    return fail(`target point x/y must be numbers from 0 through ${COORDINATE_MAX}`);
  }
  return { ok: true, value: { point: { x, y }, revision } };
}

export function validateJudgmentResponse(value: unknown): ProtocolValidation<JudgmentResponse> {
  const record = asClosedRecord(value, ['protocolVersion', 'result', 'explanation']);
  if (record === null) return fail('response is not an agent-judgment-1 object');
  if (record['protocolVersion'] !== 'agent-judgment-1') return fail('unknown protocolVersion');
  if (typeof record['result'] !== 'boolean') return fail('result must be a boolean');
  const explanation = asBoundedString(record['explanation'], 0, EXPLANATION_MAX_LENGTH);
  if (explanation === null) return fail('explanation must be a bounded string');
  return {
    ok: true,
    value: { protocolVersion: 'agent-judgment-1', result: record['result'], explanation },
  };
}

/**
 * `agent.extract` sends no provider schema, because only the caller's Standard
 * Schema knows the payload shape. Any parsed JSON value is therefore protocol
 * valid; the caller's schema is the only authority over its contents.
 */
export function acceptAnyJson(value: unknown): ProtocolValidation<unknown> {
  return { ok: true, value };
}

function fail(issue: string): { ok: false; issue: string } {
  return { ok: false, issue };
}

/** Accepts a plain object whose keys are exactly within the allowed set. */
function asClosedRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return null;
  }
  return value as Record<string, unknown>;
}

/** Accepts a finite screenshot coordinate; the viewport bound is applied later. */
function asCoordinate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > COORDINATE_MAX) return null;
  return value;
}

function asBoundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length < min || value.length > max) return null;
  return value;
}
