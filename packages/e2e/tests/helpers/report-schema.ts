/** Validates generated reports against the canonical spec report-1 schema. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const SCHEMA_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '..', '..', '..', '..', '..',
  'spec', 'schema', 'report-v1.schema.json',
);

let validator: ValidateFunction | undefined;

/** Asserts the document is schema-valid report-1; throws with details otherwise. */
export function assertValidReport(document: unknown): void {
  if (validator === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats.default(ajv);
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
    validator = ajv.compile(schema);
  }
  if (!validator(document)) {
    throw new Error(`report-1 schema violation:\n${JSON.stringify(validator.errors, null, 2)}`);
  }
}
