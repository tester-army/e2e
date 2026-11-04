import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendRun, loadHistory } from '../../src/store.ts';
import { history } from './helpers.ts';

async function tempFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), 'e2e-insights-')), 'nested', 'runs.jsonl');
}

describe('history store', () => {
  it('reads a missing file as an empty history', async () => {
    expect(await loadHistory([await tempFile()])).toEqual({ runs: [], skippedLines: 0 });
  });

  it('returns the newest keep runs and trims the file once it passes keep plus the slack', async () => {
    const file = await tempFile();
    const runs = history(Array.from({ length: 13 }, () => [{ testId: 'a', status: 'passed' as const }]));
    let returned: string[] = [];
    for (const run of runs.slice(0, 12)) returned = (await appendRun(file, run, 2)).map((entry) => entry.runId);
    expect(returned).toEqual(runs.slice(10, 12).map((run) => run.runId));
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(12);
    await appendRun(file, runs[12]!, 2);
    expect((await loadHistory([file])).runs.map((run) => run.runId)).toEqual(runs.slice(11).map((run) => run.runId));
  });

  it('keeps every run when two runs finish at the same time', async () => {
    const file = await tempFile();
    const runs = history(Array.from({ length: 6 }, () => [{ testId: 'a', status: 'passed' as const }]));
    await Promise.all(runs.map((run) => appendRun(file, run, 100)));
    expect((await loadHistory([file])).runs).toHaveLength(6);
  });

  it('keeps a newer schema’s lines when it trims, and drops only torn ones', async () => {
    const file = await tempFile();
    const newer = '{"schemaVersion":"history-2","runId":"from-a-newer-package"}';
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${newer}\n{"schemaVer\n`, 'utf8');
    for (const run of history(Array.from({ length: 12 }, () => [{ testId: 'a', status: 'passed' as const }]))) await appendRun(file, run, 1);
    const text = await readFile(file, 'utf8');
    expect(text).toContain(newer);
    expect(text).not.toContain('{"schemaVer\n');
  });

  it('skips a torn or foreign line and keeps the rest', async () => {
    const file = await tempFile();
    const [run] = history([[{ testId: 'a', status: 'passed' }]]);
    await appendRun(file, run!, 10);
    await writeFile(file, `${await readFile(file, 'utf8')}{"schemaVersion":"history-9"}\n{"schemaVer`, 'utf8');
    expect(await loadHistory([file])).toMatchObject({ runs: [{ runId: run!.runId }], skippedLines: 2 });
  });

  it('merges files by run id, oldest first', async () => {
    const [one, two, three] = history([[{ testId: 'a', status: 'passed' }], [{ testId: 'a', status: 'passed' }], [{ testId: 'a', status: 'passed' }]]);
    const left = await tempFile();
    const right = await tempFile();
    await appendRun(left, three!, 10);
    await appendRun(left, one!, 10);
    await appendRun(right, one!, 10);
    await appendRun(right, two!, 10);
    const merged = await loadHistory([left, right]);
    expect(merged.runs.map((run) => run.runId)).toEqual([one!.runId, two!.runId, three!.runId]);
  });
});
