/** Every wire schema in `schema/` accepts its valid fixture and rejects its invalid one, and ships in the package. */

import { globSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCHEMA_ROOT = path.join(PACKAGE_ROOT, 'schema');
const SHIPPED_SCHEMAS = 'schema/*.schema.json';

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
    it('constrains result tags to distinct names --tag can spell back', () => {
      const report = readJson('fixtures', 'report-v1.valid.json') as { run: { results: { tags?: string[] }[] } };
      const result = report.run.results[0]!;
      for (const tags of [[''], ['a', 'a'], [' a'], ['a,b']]) {
        result.tags = tags;
        expect(validate(report)).toBe(false);
      }
      for (const tags of [[], ['a'], ['Login Form', 'billing:refunds']]) {
        result.tags = tags;
        expect(validate(report)).toBe(true);
      }
    });

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

    it('lets only a gap name the rule that made a typed value run-time data', () => {
      const report = readJson('fixtures', 'report-v1.valid.json') as {
        run: { results: { attempts: { steps: { api: string; cache?: { mode: string; reason?: string; derived?: string } }[] }[] }[] };
      };
      const cache = report.run.results[0]!.attempts[0]!.steps.find((step) => step.api === 'agent.act')!.cache!;
      expect(cache).toMatchObject({ reason: 'gap', derived: 'minted-token' });
      expect(validate(report)).toBe(true);
      cache.reason = 'target-not-found';
      expect(validate(report)).toBe(false);
      cache.reason = 'gap';
      cache.derived = 'guessed';
      expect(validate(report)).toBe(false);
      delete cache.derived;
      expect(validate(report)).toBe(true);
    });

    it('lets a missed or handed-off step say why it was not recorded, with a closed reason', () => {
      const report = readJson('fixtures', 'report-v1.valid.json') as {
        run: { results: { attempts: { steps: { api: string; cache?: { mode: string; reason?: string; notRecorded?: string } }[] }[] }[] };
      };
      const steps = report.run.results.flatMap((result) => result.attempts.flatMap((attempt) => attempt.steps));
      const cache = steps.find((step) => step.cache?.notRecorded !== undefined)!.cache!;
      expect(cache).toMatchObject({ mode: 'missed', notRecorded: 'param-collision' });
      expect(validate(report)).toBe(true);
      cache.notRecorded = 'guessed';
      expect(validate(report)).toBe(false);
      cache.notRecorded = 'param-collision';
      cache.mode = 'self-finalized';
      delete cache.reason;
      delete (cache as { derived?: string }).derived;
      expect(validate(report)).toBe(false);
    });
  }
});

it('ships a schema for every fixture pair', () => {
  const fixtures = readdirSync(path.join(SCHEMA_ROOT, 'fixtures'))
    .map((name) => name.replace(/\.(valid|invalid)\.json$/, ''));
  expect(new Set(fixtures)).toEqual(new Set(schemas));
});

it('publishes every schema and no fixture: package.json files names the glob, and the glob matches the schema set', () => {
  const { files } = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { files: string[] };
  expect(files).toContain(SHIPPED_SCHEMAS);
  const shipped = globSync(SHIPPED_SCHEMAS, { cwd: PACKAGE_ROOT }).map((file) => file.split(path.sep).join('/'));
  expect(new Set(shipped)).toEqual(new Set(schemas.map((name) => `schema/${name}.schema.json`)));
  expect(shipped).toHaveLength(schemas.length);
});
