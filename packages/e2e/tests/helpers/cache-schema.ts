/** Validates cache entries against the canonical spec cache-1 schema. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const SPEC_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  '..', '..', '..', '..', '..',
  'spec', 'schema',
);

let validator: ValidateFunction | undefined;

function compiled(): ValidateFunction {
  if (validator === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats.default(ajv);
    const schema = JSON.parse(
      readFileSync(path.join(SPEC_ROOT, 'cache-v1.schema.json'), 'utf8'),
    ) as Record<string, unknown>;
    validator = ajv.compile(schema);
  }
  return validator;
}

/** True when the document satisfies the canonical cache-1 schema. */
export function isValidCacheEntry(document: unknown): boolean {
  return compiled()(document) as boolean;
}

/** Asserts the document is schema-valid cache-1; throws with details otherwise. */
export function assertValidCacheEntry(document: unknown): void {
  if (!isValidCacheEntry(document)) {
    throw new Error(`cache-1 schema violation:\n${JSON.stringify(compiled().errors, null, 2)}`);
  }
}

/** Loads one canonical spec fixture by name, e.g. `cache-v1.valid.json`. */
export function specFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(SPEC_ROOT, 'fixtures', name), 'utf8'));
}
