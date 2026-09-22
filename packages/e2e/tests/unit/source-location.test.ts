/**
 * The user's line in a stack as the report keeps it: relative to the project
 * root, POSIX separators; nothing for a frame outside the root, including a
 * sibling directory that shares the root's prefix. A root of `/` or one
 * ending in a separator keeps its frames.
 */

import { describe, expect, it } from 'vitest';
import { projectRelativePath, sourceLocation } from '../../src/internal/source.ts';

function stackThrough(file: string): string {
  return ['Error: boom', `    at Object.<anonymous> (${file}:14:3)`, '    at run (/repo/app/node_modules/e2e/dist/run/steps.js:9:1)'].join('\n');
}

describe('sourceLocation', () => {
  it('keeps a frame under the root relative to it', () => {
    expect(sourceLocation(stackThrough('/repo/app/tests/a.e2e.ts'), '/repo/app')).toEqual({ file: 'tests/a.e2e.ts', line: 14, column: 3 });
  });

  it('keeps a frame when the root is / or ends in a separator', () => {
    expect(sourceLocation(stackThrough('/repo/app/tests/a.e2e.ts'), '/')).toEqual({ file: 'repo/app/tests/a.e2e.ts', line: 14, column: 3 });
    expect(sourceLocation(stackThrough('/repo/app/tests/a.e2e.ts'), '/repo/app/')).toEqual({ file: 'tests/a.e2e.ts', line: 14, column: 3 });
  });

  it('names nothing for a sibling directory sharing the root prefix', () => {
    expect(sourceLocation(stackThrough('/repo/app-shared/helpers.ts'), '/repo/app')).toBeUndefined();
  });
});

describe('projectRelativePath', () => {
  it('names a file under the root relative to it, whether or not the root ends in a separator', () => {
    expect(projectRelativePath('/repo/app', '/repo/app/tests/a.e2e.ts')).toBe('tests/a.e2e.ts');
    expect(projectRelativePath('/repo/app/', '/repo/app/tests/a.e2e.ts')).toBe('tests/a.e2e.ts');
    expect(projectRelativePath('/', '/repo/app/tests/a.e2e.ts')).toBe('repo/app/tests/a.e2e.ts');
  });

  it('names nothing for the root itself', () => {
    expect(projectRelativePath('/repo/app', '/repo/app')).toBeUndefined();
    expect(projectRelativePath('/repo/app/', '/repo/app')).toBeUndefined();
  });

  it('names nothing for a file above the root or beside it', () => {
    expect(projectRelativePath('/repo/app', '/repo/helpers.ts')).toBeUndefined();
    expect(projectRelativePath('/repo/app', '/repo')).toBeUndefined();
    expect(projectRelativePath('/repo/app', '/repo/app-shared/helpers.ts')).toBeUndefined();
  });

  // A relative result that is itself absolute (a file on another drive) only
  // arises from path.win32, which the function does not use; it has no POSIX case.
});
