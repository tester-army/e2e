import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { digestReport } from '../../src/digest.ts';
import { baseReport, makeReport } from './helpers.ts';

const schemaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schema');
const read = (...parts: string[]): unknown => JSON.parse(readFileSync(path.join(schemaRoot, ...parts), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(read('history-v1.schema.json') as Record<string, unknown>);

describe('history-1 schema', () => {
  it('accepts the valid fixture and rejects the invalid one', () => {
    expect(validate(read('fixtures', 'history-v1.valid.json')), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(read('fixtures', 'history-v1.invalid.json'))).toBe(false);
  });
});

describe('digestReport', () => {
  it('digests core’s report-1 fixture into a valid history-1 record', () => {
    const record = digestReport(baseReport());
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    expect(record.schemaVersion).toBe('history-1');
  });

  it('keeps executed results only', () => {
    const record = digestReport(baseReport());
    expect(record.tests.map((test) => test.status)).toEqual(['passed', 'failed']);
  });

  it('reads a serial member’s steps, statuses, and errors from its group', () => {
    const report = baseReport();
    const attempts = report.run.serialGroups[0]!.attempts as readonly { error?: unknown; members: readonly { error?: unknown }[] }[];
    const infra = { category: 'infrastructure', code: 'WORKER_INIT_FAILED', message: 'worker exited', retryable: true };
    attempts[0]!.error = { ...infra, category: 'test', code: 'HOOK_FAILED' };
    attempts.at(-1)!.members[0]!.error = infra;
    const serial = digestReport(report).tests.find((test) => test.testId.includes('serial'))!;
    expect(serial.attempts).toEqual(['failed', 'failed']);
    expect(serial.attemptErrors).toEqual(['test', 'infrastructure']);
    expect(serial).toMatchObject({ errorCode: 'WORKER_INIT_FAILED', errorCategory: 'infrastructure' });
  });

  it('keeps the agent each result ran as', () => {
    const record = digestReport(makeReport([{ testId: 'a', status: 'passed', agent: 'fast' }]));
    expect(record.tests[0]!.agent).toBe('fast');
  });

  it('records every attempt’s error category, a retry pass included', () => {
    const record = digestReport(makeReport([{ testId: 'a', status: 'flaky', errorCategory: 'infrastructure' }]));
    expect(record.tests[0]).toMatchObject({ attempts: ['failed', 'passed'], attemptErrors: ['infrastructure', null] });
  });

  it('never stores step labels, error messages, or app text', () => {
    const report = makeReport([{ testId: 'a', status: 'failed', cache: ['missed'] }]);
    const text = JSON.stringify(digestReport(report));
    expect(text).not.toContain('secret text');
    expect(text).not.toContain('adds shoes to the cart');
    expect(text).not.toContain('A modal blocks');
    expect(text).toContain('ASSERTION_FAILED');
  });

  it('counts cache modes and miss reasons across attempts', () => {
    const record = digestReport(makeReport([{ testId: 'a', status: 'passed', cache: ['self-finalized', 'agent-concluded', 'missed'] }]));
    expect(record.tests[0]!.cache).toEqual({ steps: 3, replayed: 1, handedOff: 1, missed: 1, reasons: { 'no-entry': 2 } });
  });

  it('records the final attempt’s error category', () => {
    const record = digestReport(makeReport([{ testId: 'a', status: 'failed', errorCategory: 'infrastructure', errorCode: 'WORKER_INIT_FAILED' }]));
    expect(record.tests[0]).toMatchObject({ errorCode: 'WORKER_INIT_FAILED', errorCategory: 'infrastructure' });
  });
});
