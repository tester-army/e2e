import { describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async (original) => {
  const module = await original<typeof import('node:path')>();
  return { default: module.win32 };
});
vi.mock('node:url', async (original) => {
  const module = await original<typeof import('node:url')>();
  return { fileURLToPath: (url: string) => module.fileURLToPath(url, { windows: true }) };
});

import { sourceLocation, userFrame } from '../../src/internal/source.ts';

// The real Node Windows path/URL implementations let this parser run on every CI host.
describe('Windows stack locations', () => {
  const root = String.raw`C:\work\project`;
  const file = String.raw`C:\work\project\tests\login.e2e.ts`;

  it.each([file, file.replaceAll('\\', '/'), 'file:///C:/work/project/tests/login.e2e.ts?worker-1'])('finds a project frame from %s', (location) => {
    const stack = `    at Object.fn (${location}:28:9)`;
    expect(userFrame(stack, root)).toEqual({ file: location.startsWith('file:') ? file : location, line: 28, column: 9 });
    expect(sourceLocation(stack, root)).toEqual({ file: 'tests/login.e2e.ts', line: 28, column: 9 });
  });

  it('keeps node_modules and sibling projects out of the result', () => {
    const stack = [
      String.raw`    at helper (C:\work\project-other\test.ts:2:3)`,
      String.raw`    at poll (C:\work\project\node_modules\helper\index.js:4:5)`,
      `    at Object.fn (${file}:28:9)`,
    ].join('\n');
    expect(userFrame(stack, root)).toEqual({ file, line: 28, column: 9 });
  });

  it.each([
    'C:/work/project/node_modules/helper/index.js',
    String.raw`C:\work/project\node_modules/helper/index.js`,
  ])('skips dependency frames with mixed or forward separators: %s', (dependency) => {
    const stack = `    at poll (${dependency}:4:5)\n    at Object.fn (${file}:28:9)`;
    expect(userFrame(stack, root)).toEqual({ file, line: 28, column: 9 });
    expect(sourceLocation(stack, root)?.file).toBe('tests/login.e2e.ts');
  });

  it.each([
    [String.raw`\\server\share\project`, 'file://server/share/project/tests/login.e2e.ts'],
    [String.raw`\\server\share\project folder`, 'file://server/share/project%20folder/tests/login.e2e.ts'],
  ])('decodes UNC file URLs under %s', (uncRoot, url) => {
    const uncFile = uncRoot + String.raw`\tests\login.e2e.ts`;
    const stack = `    at Object.fn (${url}:28:9)`;
    expect(userFrame(stack, uncRoot)).toEqual({ file: uncFile, line: 28, column: 9 });
    expect(sourceLocation(stack, uncRoot)).toEqual({ file: 'tests/login.e2e.ts', line: 28, column: 9 });
  });

  it('handles UNC project roots', () => {
    const uncRoot = String.raw`\\server\share\project`;
    const uncFile = uncRoot + String.raw`\tests\login.e2e.ts`;
    expect(userFrame(`    at Object.fn (${uncFile}:28:9)`, uncRoot)).toEqual({ file: uncFile, line: 28, column: 9 });
  });
});
