import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import picocolors from 'picocolors';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { codeFrame } from '../../src/report/code-frame.ts';
import { visibleWidth } from '../../src/report/format.ts';

const directory = mkdtempSync(path.join(tmpdir(), 'e2e-code-frame-width-'));
const file = path.join(directory, 'source.ts');
const pc = picocolors.createColors(false);
const savedColumns = process.stdout.columns;
afterEach(() => { setColumns(savedColumns); rmSync(file, { force: true }); });
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });

/** Sets the terminal width the code frame measures against. */
function setColumns(columns: number | undefined): void {
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true, writable: true });
}

/** Writes `line` as the source file and renders its code frame on a terminal `columns` wide. */
function render(line: string, column: number, columns = 80): string[] {
  setColumns(columns);
  writeFileSync(file, line);
  return codeFrame({ file, line: 1, column }, pc);
}

describe('code-frame terminal columns', () => {
  it.each([
    ['ASCII', 'const x = 1; ', 13],
    ['CJK', 'const 界 = 1; ', 14],
    ['combining mark', 'const é = 1; ', 13],
    ['emoji ZWJ', 'const value = "👩‍💻"; ', 20],
    ['tab', '\tconst x = 1; ', 14],
  ])('aligns the caret after %s', (_label, prefix, prefixColumns) => {
    const rows = render(`${prefix}throw new Error();`, prefix.length + 1);
    expect(rows[1]).toBe(`   |${' '.repeat(prefixColumns + 1)}^`);
  });

  it('clips wide source text to the terminal budget without splitting glyphs', () => {
    const rows = render(`const x = "${'界'.repeat(50)}";`, 1, 40);
    expect(visibleWidth(rows[0] ?? '')).toBeLessThanOrEqual(35);
    expect(rows[0]).toMatch(/…$/u);
    expect(rows[1]).toBe('   | ^');
  });

  it('omits a caret when the failing column is outside the clipped source', () => {
    const prefix = '界'.repeat(30);
    const rows = render(`${prefix}throw new Error();`, prefix.length + 1, 40);
    expect(rows).toHaveLength(1);
    expect(visibleWidth(rows[0] ?? '')).toBeLessThanOrEqual(35);
  });
});
