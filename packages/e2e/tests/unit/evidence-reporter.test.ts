/** The evidence reporter writes nothing, and removes nothing, for a run that never reached its tests. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evidenceReporter } from '../../src/report/evidence/reporter.ts';
import type { FinishedRun } from '../../src/types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('evidenceReporter', () => {
  it('leaves the previous pack where it is when the run stopped before any test', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'evidence-reporter-'));
    dirs.push(root);
    const outDir = path.join(root, 'evidence');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'previous.evidence'), 'pack');
    const run = { report: { run: { id: 'r2' } }, projectRoot: root, artifactsRoot: path.join(root, 'artifacts'), reportPath: undefined } as unknown as FinishedRun;
    const summary = await evidenceReporter({ outDir, profile: 'L1' }).onRunFinished!(run, new AbortController().signal);
    expect(existsSync(path.join(outDir, 'previous.evidence'))).toBe(true);
    expect(existsSync(path.join(outDir, 'r2.evidence'))).toBe(false);
    expect(summary).toEqual([{ label: 'Evidence', text: 'not written: the run wrote no report' }]);
  });
});
