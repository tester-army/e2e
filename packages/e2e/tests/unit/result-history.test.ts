import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.ts';
import type { Report1Document } from '../../src/report/build.ts';
import { saveRunHistory } from '../../src/run/result-history.ts';

let root: string;

beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'e2e-history-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Writes a valid report and a small artifact tree for one snapshot. */
function prepared(index = 1) {
  const config = resolveConfig({ targets: [{ name: 'node', platform: 'test' }], keepResults: 1 }, { projectRoot: root, env: {} });
  const report = JSON.parse(readFileSync(new URL('../../schema/fixtures/report-v1.valid.json', import.meta.url), 'utf8')) as Report1Document;
  report.run.id = `018f0f5c-7b2a-7abc-8abc-${String(index).padStart(12, '0')}`;
  const output = config.output;
  mkdirSync(path.join(output, 'results/test'), { recursive: true });
  const reportPath = path.join(output, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(path.join(output, 'results/test/shot.png'), 'original screenshot');
  return { config, report, reportPath, aiTracePath: undefined, traces: new Map<string, string>() };
}

it('copies bytes independently, includes an enabled AI trace, and leaves cache, sessions and MCP recordings alone', async () => {
  const options = prepared();
  const output = options.config.output;
  for (const dir of ['cache', 'sessions', 'videos', 'results/mcp']) {
    mkdirSync(path.join(output, dir), { recursive: true });
    writeFileSync(path.join(output, dir, 'kept.txt'), dir);
  }
  const aiTracePath = path.join(output, 'ai-trace.json');
  writeFileSync(aiTracePath, 'current trace');
  const saved = await saveRunHistory({ ...options, aiTracePath });
  const archived = path.dirname(saved);
  expect(readFileSync(path.join(archived, 'ai-trace.json'), 'utf8')).toBe('current trace');
  writeFileSync(path.join(output, 'results/test/shot.png'), 'changed');
  expect(readFileSync(path.join(archived, 'results/test/shot.png'), 'utf8')).toBe('original screenshot');
  for (const dir of ['cache', 'sessions', 'videos', 'results/mcp']) {
    expect(existsSync(path.join(archived, dir))).toBe(false);
    expect(readFileSync(path.join(output, dir, 'kept.txt'), 'utf8')).toBe(dir);
  }
});

it('prunes only owned snapshots and preserves foreign directories and files', async () => {
  const first = prepared();
  const saved = await saveRunHistory(first);
  const history = path.dirname(path.dirname(saved));
  const foreign = path.join(history, '018f0f5c-7b2a-7abc-8abc-999999999999');
  mkdirSync(foreign);
  writeFileSync(path.join(foreign, 'notes.txt'), 'not e2e');
  writeFileSync(path.join(history, 'notes.txt'), 'also not e2e');
  const second = prepared(2);
  await saveRunHistory(second);
  expect(existsSync(path.dirname(saved))).toBe(false);
  expect(readFileSync(path.join(foreign, 'notes.txt'), 'utf8')).toBe('not e2e');
  expect(readFileSync(path.join(history, 'notes.txt'), 'utf8')).toBe('also not e2e');
});

it('refuses a foreign history directory and never removes its files', async () => {
  const options = prepared();
  const history = path.join(options.config.output, 'history');
  mkdirSync(history);
  writeFileSync(path.join(history, 'notes.txt'), 'mine');
  await expect(saveRunHistory(options)).rejects.toThrow(/does not own/);
  expect(readdirSync(history)).toEqual(['notes.txt']);
});

it('recovers an abandoned owned snapshot while preserving live writers, foreign entries and symlinks', async () => {
  const first = prepared();
  const saved = await saveRunHistory(first);
  const history = path.dirname(path.dirname(saved));
  const child = spawnSync(process.execPath, ['-e', '']);
  expect(child.status).toBe(0);
  const abandoned = path.join(history, `.pending-${child.pid}-abcdef`);
  const live = path.join(history, `.pending-${process.pid}-abcdef`);
  const foreign = path.join(history, `.pending-${child.pid}-ghijkl`);
  for (const directory of [abandoned, live, foreign]) {
    mkdirSync(directory);
    writeFileSync(path.join(directory, 'partial.webm'), 'partial recording');
  }
  for (const directory of [abandoned, live]) writeFileSync(path.join(directory, '.e2e-run'), first.report.run.id);
  const linked = path.join(history, `.pending-${child.pid}-mnopqr`);
  symlinkSync(live, linked, 'junction');
  await saveRunHistory(prepared(2));
  expect(existsSync(abandoned)).toBe(false);
  for (const directory of [live, foreign, linked]) expect(readFileSync(path.join(directory, 'partial.webm'), 'utf8')).toBe('partial recording');
});

it('rejects a history symlink without writing into or pruning its target', async () => {
  const options = prepared();
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'kept.txt'), 'mine');
  symlinkSync(outside, path.join(options.config.output, 'history'), 'junction');
  await expect(saveRunHistory(options)).rejects.toThrow(/not a symlink/);
  expect(readdirSync(outside)).toEqual(['kept.txt']);
});

it('rejects symlink artifacts, cleans its staging directory, and leaves earlier history intact', async () => {
  const first = prepared();
  const saved = await saveRunHistory(first);
  const second = prepared(2);
  symlinkSync(path.join(second.config.output, 'results/test'), path.join(second.config.output, 'results/linked'), 'junction');
  await expect(saveRunHistory(second)).rejects.toThrow(/link or special file/);
  const history = path.join(second.config.output, 'history');
  expect(readdirSync(history).some((name) => name.startsWith('.pending-'))).toBe(false);
  expect(existsSync(saved)).toBe(true);
  expect(existsSync(path.join(history, second.report.run.id))).toBe(false);
});
