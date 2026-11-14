/**
 * Best-effort JSON Schema projection of a caller-supplied Standard Schema v1.
 *
 * Standard Schema v1 has no required JSON Schema projection, but zod and any
 * vendor exposing the `~standard.jsonSchema` converter can produce one. When a
 * projection exists the runner sends its shape as a provider structured-output
 * schema so the shape is enforced instead of guessed; otherwise the extraction
 * falls back to text mode plus the validation-issue repair loop.
 *
 * The projection is only a provider hint, and a shape only: types, members,
 * and allowed literals. Value rules (ranges, lengths, patterns, formats) are
 * left out, because a provider that enforces them makes the model produce a
 * value that fits rather than the one on screen. The caller's
 * `~standard.validate` remains the sole authority over the extracted value.
 */

import type { JSONSchema7 } from 'ai';
import type { StandardSchemaV1 } from '../../types.ts';
import { loadAiSdk } from '../ai-sdk.ts';

/** The caller schema's shape as JSON Schema, or undefined when it has no usable projection. */
export async function deriveJsonSchema(
  schema: StandardSchemaV1,
): Promise<JSONSchema7 | undefined> {
  try {
    // The projection is best-effort by contract, so a missing optional AI SDK
    // degrades to text mode here; the model call itself reports it properly.
    const { asSchema } = await loadAiSdk();
    const projected = await asSchema(schema as never).jsonSchema;
    return isUsable(projected) ? shapeOf(projected as JSONSchema7) : undefined;
  } catch {
    return undefined;
  }
}

/** A schema with no type or members constrains nothing and is rejected by some providers. */
function isUsable(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
  const record = schema as Record<string, unknown>;
  return (
    record['type'] !== undefined ||
    record['properties'] !== undefined ||
    record['anyOf'] !== undefined ||
    record['oneOf'] !== undefined ||
    record['$ref'] !== undefined
  );
}

/** Keywords that describe a value's shape; everything else is a value rule, or metadata the provider does not need. */
const SHAPE_KEYWORDS = new Set(['type', 'enum', 'const', 'required', 'nullable', 'description', '$ref']);
/** Keywords whose value is one subschema. */
const SUBSCHEMA_KEYWORDS = new Set(['items', 'additionalProperties']);
/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems', 'items']);
/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAP_KEYWORDS = new Set(['properties', 'definitions', '$defs']);

/**
 * A schema with its value rules removed, recursively. An `allOf` member left
 * with nothing but the type it refines (zod writes a second `pattern` that
 * way) is dropped with its rule.
 */
function shapeOf(schema: JSONSchema7): JSONSchema7 {
  const shape: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (SHAPE_KEYWORDS.has(keyword)) {
      shape[keyword] = value;
    } else if (SUBSCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(value)) {
      const members = (value as JSONSchema7[]).map(shapeOf);
      const kept = keyword === 'allOf' ? members.filter((member) => !refinesOnly(member, schema.type)) : members;
      if (kept.length > 0) shape[keyword] = kept;
    } else if (SUBSCHEMA_KEYWORDS.has(keyword)) {
      shape[keyword] = isSchemaObject(value) ? shapeOf(value) : value;
    } else if (SUBSCHEMA_MAP_KEYWORDS.has(keyword) && isSchemaObject(value)) {
      shape[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, member]) => [name, isSchemaObject(member) ? shapeOf(member) : member]),
      );
    }
  }
  return shape as JSONSchema7;
}

/** Whether a projected `allOf` member says nothing beyond the parent's own type. */
function refinesOnly(member: JSONSchema7, type: JSONSchema7['type']): boolean {
  const keys = Object.keys(member);
  return keys.length === 0 || (keys.length === 1 && JSON.stringify(member.type) === JSON.stringify(type));
}

function isSchemaObject(value: unknown): value is JSONSchema7 {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
