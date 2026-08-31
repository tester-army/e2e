/**
 * Best-effort JSON Schema projection of a caller-supplied Standard Schema v1.
 *
 * Standard Schema v1 has no required JSON Schema projection, but zod and any
 * vendor exposing the `~standard.jsonSchema` converter can produce one. When a
 * projection exists the runner sends it as a provider structured-output schema
 * so the shape is enforced instead of guessed; otherwise the extraction falls
 * back to text mode plus the validation-issue repair loop.
 *
 * The projection is only a provider hint. The caller's `~standard.validate`
 * remains the sole authority over the extracted value.
 */

import type { JSONSchema7 } from 'ai';
import type { StandardSchemaV1 } from '../../types.ts';
import { loadAiSdk } from '../ai-sdk.ts';

export async function deriveJsonSchema(
  schema: StandardSchemaV1,
): Promise<JSONSchema7 | undefined> {
  try {
    // The projection is best-effort by contract, so a missing optional AI SDK
    // degrades to text mode here; the model call itself reports it properly.
    const { asSchema } = await loadAiSdk();
    const projected = await asSchema(schema as never).jsonSchema;
    return isUsable(projected) ? (projected as JSONSchema7) : undefined;
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
