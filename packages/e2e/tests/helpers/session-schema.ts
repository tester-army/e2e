/** Validates session envelopes against the canonical spec session-1 schema. */

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
      readFileSync(path.join(SPEC_ROOT, 'session-v1.schema.json'), 'utf8'),
    ) as Record<string, unknown>;
    validator = ajv.compile(schema);
  }
  return validator;
}

/** True when the document satisfies the canonical session-1 schema. */
export function isValidSessionEnvelope(document: unknown): boolean {
  return compiled()(document) as boolean;
}

/** Asserts the document is schema-valid session-1; throws with details otherwise. */
export function assertValidSessionEnvelope(document: unknown): void {
  if (!isValidSessionEnvelope(document)) {
    throw new Error(`session-1 schema violation:\n${JSON.stringify(compiled().errors, null, 2)}`);
  }
}

/** Loads one canonical spec fixture by name, e.g. `session-v1.valid.json`. */
export function specFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(SPEC_ROOT, 'fixtures', name), 'utf8'));
}
