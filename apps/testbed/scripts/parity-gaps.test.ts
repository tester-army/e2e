import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { diffGaps, keyOf, readGaps, TODO_REASON, writeGaps, type ParityResult } from './parity-gaps.ts';

/** A selected result in tests-parity/a.e2e.ts on chromium, overridable per test. */
function result(title: string, status: string, overrides: Partial<ParityResult> = {}): ParityResult {
  return { file: 'tests-parity/a.e2e.ts', titlePath: ['suite', title], targetId: 'chromium', status, selected: true, ...overrides };
}

const gap = (title: string, target = 'chromium', file = 'a.e2e.ts') => `${file} > suite > ${title} [${target}]`;

/** Writes `lines` to a temporary gaps file, hands it to `body`, and removes it. */
function withGapsFile(lines: readonly string[], body: (file: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'parity-gaps-'));
  try {
    const file = path.join(dir, 'expected-gaps.txt');
    writeFileSync(file, `# header\n\n${lines.join('\n')}\n`);
    body(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('keyOf drops the tests folder and names the target', () => {
  assert.equal(keyOf(result('works', 'passed')), 'a.e2e.ts > suite > works [chromium]');
});

test('readGaps splits each line at the target, so a reason may hold the separator', () => {
  withGapsFile([`${gap('works ? | yes')} | a | b`], (file) => {
    assert.deepEqual([...readGaps(file)], [[gap('works ? | yes'), 'a | b']]);
  });
});

test('a listed failure is expected; an unlisted one is not', () => {
  const diff = diffGaps(new Map([[gap('known'), 'why']]), [result('known', 'failed'), result('new', 'timed-out')]);
  assert.deepEqual(diff, { unexpected: [gap('new')], closed: [], stale: [], todo: [] });
});

test('a listed test that passes closes its gap', () => {
  assert.deepEqual(diffGaps(new Map([[gap('fixed'), 'why']]), [result('fixed', 'passed')]).closed, [gap('fixed')]);
});

test('a listed test that skipped or is gone from a file that ran is stale', () => {
  const gaps = new Map([[gap('skipped'), 'why'], [gap('renamed'), 'why']]);
  assert.deepEqual(diffGaps(gaps, [result('skipped', 'skipped'), result('other', 'passed')]).stale, [gap('renamed'), gap('skipped')]);
});

test('lines of a file, target, or test the run did not select are left alone', () => {
  const gaps = new Map([
    [gap('other file', 'chromium', 'b.e2e.ts'), 'why'],
    [gap('other target', 'firefox'), 'why'],
    [gap('filtered'), 'why'],
  ]);
  const diff = diffGaps(gaps, [result('ran', 'passed'), result('filtered', 'skipped', { selected: false })]);
  assert.deepEqual(diff, { unexpected: [], closed: [], stale: [], todo: [] });
});

test('a TODO reason is reported', () => {
  assert.deepEqual(diffGaps(new Map([[gap('known'), TODO_REASON]]), [result('known', 'failed')]).todo, [gap('known')]);
});

test('writeGaps keeps reasons and unjudged lines, drops closed ones, and marks new ones TODO', () => {
  const lines = [`${gap('known')} | why`, `${gap('fixed')} | old`, `${gap('elsewhere', 'firefox')} | kept`];
  withGapsFile(lines, (file) => {
    writeGaps(file, '# header', readGaps(file), [result('known', 'failed'), result('fixed', 'passed'), result('new', 'interrupted')]);
    assert.equal(readFileSync(file, 'utf8'), [
      '# header',
      `${gap('elsewhere', 'firefox')} | kept`,
      `${gap('known')} | why`,
      `${gap('new')} | ${TODO_REASON}`,
      '',
    ].join('\n'));
  });
});
