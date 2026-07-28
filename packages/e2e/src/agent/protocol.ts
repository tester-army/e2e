/**
 * Closed `agent-protocol-1` response grammars. Mirrors
 * spec/schema/agent-locate-v1.schema.json and agent-judgment-v1.schema.json;
 * the spec files win on any divergence.
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

function locateSchema(targets: readonly JSONSchema7[]): JSONSchema7 {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['protocolVersion', 'target', 'explanation'],
    properties: {
      // Single-value enum rather than const: strict structured-output modes
      // across providers accept enum but not const.
      protocolVersion: { type: 'string', enum: ['agent-locate-1'] },
      target: { anyOf: [...targets, { type: 'null' }] },
      explanation: { type: 'string', maxLength: EXPLANATION_MAX_LENGTH },
    },
  };
}

export const LOCATE_SCHEMA: JSONSchema7 = locateSchema([NODE_TARGET_SCHEMA]);

/**
 * The locate grammar of a vision call. Pointing is a separate grammar rather
 * than an always-available branch so a tree-only call can never be answered
 * with a coordinate.
 */
export const LOCATE_VISION_SCHEMA: JSONSchema7 = locateSchema([
  NODE_TARGET_SCHEMA,
  POINT_TARGET_SCHEMA,
]);

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
 * Validates one locate response. `allowPoint` mirrors the grammar the call was
 * made under: a point answered to a tree-only call is invalid output, never a
 * silently accepted coordinate.
 */
export function validateLocateResponse(
  value: unknown,
  options: { allowPoint?: boolean } = {},
): ProtocolValidation<LocateResponse> {
  const record = asClosedRecord(value, ['protocolVersion', 'target', 'explanation']);
  if (record === null) return fail('response is not an agent-locate-1 object');
  if (record['protocolVersion'] !== 'agent-locate-1') return fail('unknown protocolVersion');
  const explanation = asBoundedString(record['explanation'], 0, EXPLANATION_MAX_LENGTH);
  if (explanation === null) return fail('explanation must be a bounded string');
  if (record['target'] === null) {
    return {
      ok: true,
      value: { protocolVersion: 'agent-locate-1', target: null, explanation },
    };
  }
  const target = validateTarget(record['target'], options.allowPoint === true);
  if (!target.ok) return target;
  return {
    ok: true,
    value: { protocolVersion: 'agent-locate-1', target: target.value, explanation },
  };
}

function validateTarget(value: unknown, allowPoint: boolean): ProtocolValidation<LocateTarget> {
  const node = asClosedRecord(value, ['id', 'revision']);
  if (node !== null) {
    const id = asBoundedString(node['id'], 1, REF_MAX_LENGTH);
    const revision = asBoundedString(node['revision'], 1, REF_MAX_LENGTH);
    if (id === null || revision === null) return fail('target id/revision are invalid');
    return { ok: true, value: { id, revision } };
  }
  const pointTarget = asClosedRecord(value, ['point', 'revision']);
  if (pointTarget === null) {
    return fail(
      allowPoint
        ? 'target is not a node reference, a point, or null'
        : 'target is not a node reference or null',
    );
  }
  if (!allowPoint) {
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
