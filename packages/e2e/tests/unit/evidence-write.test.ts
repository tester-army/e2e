/** Writing a planned pack to disk, then sealing it: what the evidence library accepts, and what is left out when a file is gone. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackPlan } from '../../src/report/evidence/map.ts';
import { sealPack } from '../../src/report/evidence/seal.ts';
import { writePack } from '../../src/report/evidence/write.ts';

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function roots() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'evidence-write-'));
  bases.push(base);
  const projectRoot = path.join(base, 'project');
  const artifactsRoot = path.join(projectRoot, '.e2e', 'artifacts');
  mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
  mkdirSync(path.join(artifactsRoot, 'web', 't', 'screenshots'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'tests', 'a.e2e.ts'), "test('a', async () => {});\n");
  writeFileSync(path.join(artifactsRoot, 'web', 't', 'screenshots', '001-step-0.png'), 'png');
  return { base, projectRoot, artifactsRoot };
}

function plan(overrides: { failureShot?: string; steps?: boolean } = {}): PackPlan {
  const steps = overrides.steps === false
    ? []
    : [
        { folder: '1-0-0', record: { api: 'app.open' }, screenshot: 'web/t/screenshots/001-step-0.png' },
        {
          folder: '2-0-1',
          record: { api: 'expect.toHaveText' },
          ...(overrides.failureShot === undefined ? {} : { screenshot: overrides.failureShot }),
          failure: {
            step: '0-1',
            status: 'failed',
            error: { message: 'expect.toHaveText failed', code: 'ASSERTION_FAILED' },
            page_state: { url: 'http://x/', ...(overrides.failureShot === undefined ? {} : { screenshot: 'steps/2-0-1/screenshot.png' }) },
          },
        },
      ];
  return {
    run: { evidence: '0.1', run_id: 'r1', status: 'running', started: '2026-10-02T00:00:00.000Z', title: 'p', environment: { producer: { name: 'e2e', version: '1' } } },
    coverage: { summary: {} },
    tests: [{
      dir: 'a-00000001',
      definition: { name: 'test.json', content: '{"e2e_test_id":"tests/a.e2e.ts::a"}\n' },
      result: {
        evidence: '0.1',
        test: 'a-00000001',
        status: overrides.steps === false ? 'skipped' : 'failed',
        definition: { path: 'test.json' },
        steps: overrides.steps === false ? [] : [{ id: '0-0', ordinal: 1, status: 'passed' }, { id: '0-1', ordinal: 2, status: 'failed' }],
      },
      steps,
      logs: [
        { name: 'steps', file: 'steps.ndjson', format: 'ndjson', content: '{}\n' },
        { name: 'trace', file: 'trace.zip', format: 'playwright-trace', source: 'web/t/trace/gone.zip' },
      ],
    }],
  };
}

describe('writePack and sealPack', () => {
  it('writes a pack the evidence library seals and validates at L1', async () => {
    const { base, artifactsRoot } = roots();
    const dir = path.join(base, 'out', 'r1.evidence');
    await writePack(plan(), dir, { artifactsRoot });
    expect(readFileSync(path.join(dir, 'tests', 'a-00000001', 'steps', '1-0-0', 'screenshot.png'), 'utf8')).toBe('png');
    const sealed = await sealPack(dir, '2026-10-02T00:01:00.000Z', 'L1');
    expect(sealed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(sealed.valid).toBe(true);
    expect(sealed.totals).toMatchObject({ tests: 1, failed: 1 });
  });

  it('declares no log and references no frame whose file is gone', async () => {
    const { base, artifactsRoot } = roots();
    const dir = path.join(base, 'out', 'r2.evidence');
    await writePack(plan({ failureShot: 'web/t/screenshots/missing.png' }), dir, { artifactsRoot });
    const meta = JSON.parse(readFileSync(path.join(dir, 'tests', 'a-00000001', 'logs', 'meta.yaml'), 'utf8')) as { logs: { name: string }[] };
    expect(meta.logs.map((log) => log.name)).toEqual(['steps']);
    const failure = JSON.parse(readFileSync(path.join(dir, 'tests', 'a-00000001', 'steps', '2-0-1', 'failure.yaml'), 'utf8')) as { page_state: object };
    expect(failure.page_state).toEqual({ url: 'http://x/' });
    expect((await sealPack(dir, '2026-10-02T00:01:00.000Z', 'L1')).valid).toBe(true);
  });

  it('copies nothing from outside the artifacts root, and writes the definition it was given rather than a source file', async () => {
    const { base, artifactsRoot } = roots();
    writeFileSync(path.join(base, 'secret.txt'), 'outside');
    const dir = path.join(base, 'out', 'r3.evidence');
    await writePack(plan({ failureShot: '../../../secret.txt' }), dir, { artifactsRoot });
    expect(existsSync(path.join(dir, 'tests', 'a-00000001', 'steps', '2-0-1', 'screenshot.txt'))).toBe(false);
    expect(readFileSync(path.join(dir, 'tests', 'a-00000001', 'test.json'), 'utf8')).toContain('tests/a.e2e.ts::a');
    expect(existsSync(path.join(dir, 'tests', 'a-00000001', 'a.e2e.ts'))).toBe(false);
  });

  it('keeps the steps folder of a test that ran none, so the sealed pack still has it', async () => {
    const { base, artifactsRoot } = roots();
    const dir = path.join(base, 'out', 'r4.evidence');
    await writePack(plan({ steps: false }), dir, { artifactsRoot });
    const sealed = await sealPack(dir, '2026-10-02T00:01:00.000Z', 'L1');
    expect(sealed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });

  it('fails loudly when it cannot write into the pack, rather than dropping the file', async () => {
    const { base, artifactsRoot } = roots();
    const dir = path.join(base, 'out', 'r5.evidence');
    // A directory where the definition file must go makes writing it fail.
    mkdirSync(path.join(dir, 'tests', 'a-00000001', 'test.json'), { recursive: true });
    await expect(writePack(plan(), dir, { artifactsRoot })).rejects.toThrow();
  });
});
