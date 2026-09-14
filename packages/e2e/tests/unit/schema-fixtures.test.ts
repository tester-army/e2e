/** Every wire schema in `schema/` accepts its valid fixture and rejects its invalid one. */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const SCHEMA_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'schema');

const schemas = readdirSync(SCHEMA_ROOT)
  .filter((name) => name.endsWith('.schema.json'))
  .map((name) => name.replace(/\.schema\.json$/, ''));

function readJson(...segments: string[]): unknown {
  return JSON.parse(readFileSync(path.join(SCHEMA_ROOT, ...segments), 'utf8'));
}

describe.each(schemas)('%s schema', (name) => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validate = ajv.compile(readJson(`${name}.schema.json`) as Record<string, unknown>);

  it('accepts the valid fixture', () => {
    const ok = validate(readJson('fixtures', `${name}.valid.json`));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('rejects the invalid fixture', () => {
    expect(validate(readJson('fixtures', `${name}.invalid.json`))).toBe(false);
  });

  if (name === 'report-v1') {
    it('requires judgment evidence after a model call, while allowing capture failures before one', () => {
      const report = readJson('fixtures', 'report-v1.valid.json') as {
        run: { results: { attempts: { steps: { api: string; status: string; metrics: { modelCalls: number }; observationRevision?: string; explanation?: string }[] }[] }[] };
      };
      const judgment = report.run.results[0]!.attempts[0]!.steps.find((step) => step.api === 'agent.assert')!;
      expect(judgment.metrics.modelCalls).toBe(0);
      expect(validate(report)).toBe(true);
      judgment.status = 'passed';
      expect(validate(report)).toBe(false);
      judgment.status = 'failed';
      judgment.metrics.modelCalls = 1;
      expect(validate(report)).toBe(false);
      expect(validate.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ keyword: 'required', params: { missingProperty: 'observationRevision' } }),
        expect.objectContaining({ keyword: 'required', params: { missingProperty: 'explanation' } }),
      ]));
      judgment.observationRevision = 'b1';
      judgment.explanation = 'visible in the screenshot';
      expect(validate(report)).toBe(true);
    });
  }
});

it('ships a schema for every fixture pair', () => {
  const fixtures = readdirSync(path.join(SCHEMA_ROOT, 'fixtures'))
    .map((name) => name.replace(/\.(valid|invalid)\.json$/, ''));
  expect(new Set(fixtures)).toEqual(new Set(schemas));
});
