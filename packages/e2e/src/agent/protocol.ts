/**
 * Closed `agent-protocol-1` response grammars. The judgment grammar mirrors
 * `schema/agent-judgment-v2.schema.json`; the schema wins on any divergence,
 * and `tests/unit/agent-judgment-schema.test.ts` holds both to the same answers.
 * The extract envelope has no published schema: its value is the caller's.
 *
 * Validation is runner-owned: a response that does not match exactly is a
 * policy error before any engine dispatch.
 */

import type { JSONSchema7 } from 'ai';

/**
 * The three answers a judgment can give. `holds` and `fails` are product
 * verdicts. `inconclusive` says the observation does not carry enough evidence
 * to decide either way; the runner treats it as a failure, never as a pass,
 * because a judge that guesses when the screen is silent is how a broken flow
 * stays green.
 */
type JudgmentVerdict = 'holds' | 'fails' | 'inconclusive';

const JUDGMENT_VERDICTS: readonly JudgmentVerdict[] = ['holds', 'fails', 'inconclusive'];

interface JudgmentResponse {
  readonly protocolVersion: 'agent-judgment-2';
  readonly explanation: string;
  readonly verdict: JudgmentVerdict;
}

export type ProtocolValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issue: string };

const EXPLANATION_MAX_LENGTH = 8192;

/**
 * The explanation comes before the verdict on purpose: providers that emit
 * structured output in schema order then make the model reason before it
 * decides, and a verdict written first was seen to contradict the reasoning
 * that followed it.
 */
export const JUDGMENT_SCHEMA: JSONSchema7 = {
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'explanation', 'verdict'],
  properties: {
    protocolVersion: { type: 'string', enum: ['agent-judgment-2'] },
    explanation: { type: 'string', maxLength: EXPLANATION_MAX_LENGTH },
    verdict: { type: 'string', enum: [...JUDGMENT_VERDICTS] },
  },
};

export function validateJudgmentResponse(value: unknown): ProtocolValidation<JudgmentResponse> {
  const record = asClosedRecord(value, ['protocolVersion', 'verdict', 'explanation']);
  if (record === null) return fail('response is not an agent-judgment-2 object');
  if (record['protocolVersion'] !== 'agent-judgment-2') return fail('unknown protocolVersion');
  const verdict = record['verdict'];
  if (!isJudgmentVerdict(verdict)) return fail('verdict must be "holds", "fails", or "inconclusive"');
  const explanation = asBoundedString(record['explanation'], 0, EXPLANATION_MAX_LENGTH);
  if (explanation === null) return fail('explanation must be a bounded string');
  return {
    ok: true,
    value: { protocolVersion: 'agent-judgment-2', verdict, explanation },
  };
}

function isJudgmentVerdict(value: unknown): value is JudgmentVerdict {
  return JUDGMENT_VERDICTS.some((verdict) => verdict === value);
}

/** The `agent.extract` response grammar's name, sent as the structured-output name. */
export const EXTRACT_SCHEMA_NAME = 'agent-extract-2';

/**
 * An extraction answer. `found: false` is the model's outlet for data the
 * screen does not show: without it a required field can only be filled with a
 * placeholder or an invented value that the caller's schema then accepts.
 */
type ExtractResponse =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false; readonly missing: string | undefined };

/** Where the caller's shape moves when it refers to its own root, so `#` refs still reach it inside the envelope; suffixed until no caller definition has the name. */
const EXTRACT_VALUE_DEFINITION = 'extractValue';

/**
 * The provider schema of an extraction: the caller's shape wrapped in the
 * `agent-extract-2` envelope. Every property is required and the value is
 * nullable rather than optional, which strict structured-output providers
 * need. The shape's definitions move to the root, where its `$ref`s point;
 * a shape that refers to its own root (`$ref: "#"`, a recursive zod root)
 * moves there too, and those refs follow it, or they would name the envelope.
 */
export function extractSchema(shape: JSONSchema7): JSONSchema7 {
  const { definitions, $defs, ...value } = shape;
  const selfReferencing = refersToRoot(value) || Object.values({ ...definitions, ...$defs }).some(refersToRoot);
  const name = freeName(EXTRACT_VALUE_DEFINITION, new Set([...Object.keys(definitions ?? {}), ...Object.keys($defs ?? {})]));
  const target = `#/definitions/${name}`;
  const moved = <Schema>(schema: Schema): Schema => (selfReferencing ? retargetRootRefs(schema, target) : schema);
  const hoisted = {
    ...(definitions === undefined ? {} : moved(definitions)),
    ...(selfReferencing ? { [name]: moved(value) } : {}),
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['found', 'value', 'missing'],
    properties: {
      found: { type: 'boolean', description: 'false only when the observation cannot answer the instruction' },
      value: { anyOf: [selfReferencing ? { $ref: target } : value, { type: 'null' }], description: 'the extracted data; null when not found' },
      missing: { type: ['string', 'null'], description: 'when not found, what the observation lacks; null otherwise' },
    },
    ...(Object.keys(hoisted).length === 0 ? {} : { definitions: hoisted }),
    ...($defs === undefined ? {} : { $defs: moved($defs) }),
  };
}

/** `base`, or `base` with the first numeric suffix no name in `taken` has. */
function freeName(base: string, taken: ReadonlySet<string>): string {
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}${String(suffix)}`;
  return name;
}

/** Whether a schema holds a `$ref` into its own root other than through its definitions. */
function refersToRoot(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  if (Array.isArray(schema)) return schema.some(refersToRoot);
  return Object.entries(schema).some(([key, member]) =>
    key === '$ref' ? typeof member === 'string' && isRootRef(member) : refersToRoot(member));
}

/** `#` and pointers into the root's own body, not into its definitions. */
function isRootRef(ref: string): boolean {
  return ref === '#' || (ref.startsWith('#/') && !ref.startsWith('#/definitions/') && !ref.startsWith('#/$defs/'));
}

/** The schema with every root ref pointed at `target` instead, the rest of the pointer kept. */
function retargetRootRefs<Schema>(schema: Schema, target: string): Schema {
  if (typeof schema !== 'object' || schema === null) return schema;
  if (Array.isArray(schema)) return schema.map((member: unknown) => retargetRootRefs(member, target)) as Schema;
  return Object.fromEntries(Object.entries(schema).map(([key, member]: [string, unknown]) => [
    key,
    key === '$ref' && typeof member === 'string' && isRootRef(member) ? `${target}${member.slice(1)}` : retargetRootRefs(member, target),
  ])) as Schema;
}

/**
 * Validates the envelope only. The value inside is the caller's to judge:
 * its Standard Schema is the only authority over extracted data.
 */
export function validateExtractResponse(value: unknown): ProtocolValidation<ExtractResponse> {
  const record = asClosedRecord(value, ['found', 'value', 'missing']);
  if (record === null) return fail('response is not an agent-extract-2 object with found, value, and missing');
  if (record['found'] === true) return { ok: true, value: { found: true, value: record['value'] } };
  if (record['found'] !== false) return fail('found must be true or false');
  const missing = record['missing'];
  if (missing === null || missing === undefined) return { ok: true, value: { found: false, missing: undefined } };
  const bounded = asBoundedString(missing, 0, EXPLANATION_MAX_LENGTH);
  if (bounded === null) return fail('missing must be a bounded string or null');
  return { ok: true, value: { found: false, missing: bounded.trim() === '' ? undefined : bounded } };
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

function asBoundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const length = codePointLength(value);
  if (length < min || length > max) return null;
  return value;
}

/**
 * Counts code points, the unit JSON Schema `maxLength` measures. `.length`
 * counts UTF-16 units, so an explanation with astral characters would fail
 * here while the schema accepts it. The string iterator pairs surrogates and
 * counts a lone one as a single code point, as Ajv's `ucs2length` does.
 */
function codePointLength(value: string): number {
  return [...value].length;
}
