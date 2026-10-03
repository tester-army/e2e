/** The cross-check's committed expectations: keys, the diff, and the rewrite that keeps reasons. */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffExpectations, keyOf, readExpectations, TODO_REASON, writeExpectations } from '../crosscheck/expectations.ts';

const fileRole = { oracle: 'chrome', field: 'role', node: 'textbox "Attachments"', ours: 'textbox', theirs: 'button' } as const;
const inert = { oracle: 'chrome', field: 'unknown', node: 'button "Inert"', ours: 'button', theirs: 'no AX node' } as const;

function file(content: string): string {
  const target = path.join(mkdtempSync(path.join(os.tmpdir(), 'crosscheck-')), 'expected.txt');
  writeFileSync(target, content);
  return target;
}

describe('cross-check expectations', () => {
  it('reports what is new and what no longer happens, only for the pages that ran', () => {
    const expected = readExpectations(file([
      '# header',
      `${keyOf('fixture: inputs', fileRole)} | a bug`,
      `${keyOf('fixture: hidden', inert)} | another`,
      `${keyOf('benchmark: other', inert)} | not run`,
      '',
    ].join('\n')));
    const seen = new Set([keyOf('fixture: inputs', fileRole), keyOf('fixture: inputs', inert)]);
    expect(diffExpectations(expected, seen, new Set(['fixture: inputs', 'fixture: hidden']))).toEqual({
      unexpected: [keyOf('fixture: inputs', inert)],
      stale: [keyOf('fixture: hidden', inert)],
    });
  });

  it('rewrites the pages that ran, keeps surviving reasons and pages that did not run, and marks new lines TODO', () => {
    const target = file(`${keyOf('fixture: inputs', fileRole)} | a bug\n${keyOf('benchmark: other', inert)} | not run\n`);
    const expected = readExpectations(target);
    writeExpectations(target, '# header', expected, new Set([keyOf('fixture: inputs', fileRole), keyOf('fixture: inputs', inert)]), new Set(['fixture: inputs']));
    expect(readFileSync(target, 'utf8')).toBe([
      '# header',
      `${keyOf('benchmark: other', inert)} | not run`,
      `${keyOf('fixture: inputs', fileRole)} | a bug`,
      `${keyOf('fixture: inputs', inert)} | ${TODO_REASON}`,
      '',
    ].join('\n'));
  });
});
