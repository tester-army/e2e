import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resultId } from '../../src/internal/ids.ts';
import { lastFailedIds, readLastRun } from '../../src/run/last-run.ts';

let dir: string;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

/** Writes `content` as the report file of a fresh project directory and returns its path. */
function reportFile(content: string): string {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-last-run-'));
  const file = path.join(dir, 'report.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

/** A report whose results each name a test by `id` as their test id, on target `web` as agent `default`. */
function report(results: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    schemaVersion: 'report-1',
    run: { results: results.map((result) => ({ ...result, testId: result['id'], targetId: 'web', agent: 'default' })) },
  });
}

const idOf = (testId: string) => resultId(testId, 'web', 'default');
const readLastFailed = async (file: string): Promise<ReadonlySet<string>> => lastFailedIds(await readLastRun(file));

describe('readLastRun and lastFailedIds', () => {
  it('collects the ids of the results that did not pass or that the run never carried out', async () => {
    const ids = await readLastFailed(
      reportFile(
        report([
          { id: 'passed', status: 'passed' },
          { id: 'flaky', status: 'flaky' },
          { id: 'failed', status: 'failed' },
          { id: 'timed-out', status: 'timed-out' },
          { id: 'interrupted', status: 'interrupted' },
          { id: 'explicit', status: 'skipped', skip: { cause: 'explicit', reason: 'later' } },
          { id: 'filtered', status: 'skipped', skip: { cause: 'filtered', reason: 'tag filter did not match' } },
          { id: 'setup-failed', status: 'skipped', skip: { cause: 'setup-failed', reason: 'setup for session "user" failed' } },
          { id: 'predecessor', status: 'skipped', skip: { cause: 'serial-predecessor-failed', reason: 'step 1 failed' } },
          { id: 'hook', status: 'skipped', skip: { cause: 'hook-failed', reason: 'beforeAll failed' } },
          { id: 'worker', status: 'skipped', skip: { cause: 'infrastructure-unavailable', reason: 'worker process exited' } },
          { id: 'no-skip', status: 'skipped' },
        ]),
      ),
    );
    expect([...ids]).toEqual(['failed', 'timed-out', 'interrupted', 'setup-failed', 'predecessor', 'hook', 'worker'].map(idOf));
  });

  it('is empty when every result passed, and names a test once however many of its repeats failed', async () => {
    expect((await readLastFailed(reportFile(report([{ id: 'a', status: 'passed' }])))).size).toBe(0);
    const repeated = await readLastFailed(
      reportFile(report([{ id: 'a', status: 'passed', repeat: 0 }, { id: 'a', status: 'failed', repeat: 1 }, { id: 'a', status: 'failed', repeat: 2 }])),
    );
    expect([...repeated]).toEqual([idOf('a')]);
  });

  it('is NO_LAST_RUN when no report exists, with the path and the way out', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-last-run-'));
    const missing = path.join(dir, 'report.json');
    await expect(readLastRun(missing)).rejects.toMatchObject({
      code: 'NO_LAST_RUN',
      category: 'configuration',
      message: `--last-failed needs the report of a previous run, and none is at ${missing}; run once without the flag first`,
    });
  });

  it('is NO_LAST_RUN when the file is not JSON or not a report-1 document', async () => {
    await expect(readLastRun(reportFile('{'))).rejects.toMatchObject({
      code: 'NO_LAST_RUN',
      message: expect.stringMatching(/^--last-failed found no report in .*report\.json: /u),
    });
    for (const content of [
      'null',
      '[]',
      '{"schemaVersion":"report-2","run":{"results":[]}}',
      '{"schemaVersion":"report-1","run":{}}',
      '{"schemaVersion":"report-1","run":{"results":[null]}}',
      '{"schemaVersion":"report-1","run":{"results":[{"id":"a"}]}}',
      '{"schemaVersion":"report-1","run":{"results":[{"id":"a","status":"skipped","skip":"later"}]}}',
    ]) {
      await expect(readLastRun(reportFile(content)), content).rejects.toMatchObject({
        code: 'NO_LAST_RUN',
        message: expect.stringMatching(/^--last-failed needs a report-1 document at .*report\.json, which holds something else; run once without the flag to write one$/u),
      });
    }
  });
});
