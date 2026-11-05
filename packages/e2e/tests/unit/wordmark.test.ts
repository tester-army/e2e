import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { playWordmark, wordmarkBanner, type WordmarkStream } from '../../src/cli/wordmark.ts';

vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)),
}));

const ESC = '\u001b';

const REST = [
  '                   ███████████',
  '   ██████████     ████     █████     ██████████',
  ' ████      ████           ████     ████      ████',
  '█████████████████      ████      █████████████████',
  ' ████              █████          ████',
  '   ██████████     ██████████████     ██████████',
];
interface FakeStream extends WordmarkStream {
  readonly writes: string[];
}

function stream(options: { tty?: boolean; columns?: number; rows?: number } = {}): FakeStream {
  const writes: string[] = [];
  return {
    writes,
    isTTY: options.tty ?? true,
    columns: options.columns ?? 100,
    rows: options.rows ?? 40,
    write(text: string) {
      writes.push(text);
      return true;
    },
  };
}

describe('wordmarkBanner', () => {
  it('draws the logo at rest as plain full blocks, one row per bar, in the terminal foreground', () => {
    expect(wordmarkBanner(stream())).toBe(`${REST.join('\n')}\n`);
  });

  it('is empty when the output is not a terminal, or a terminal too narrow for it', () => {
    expect(wordmarkBanner(stream({ tty: false }))).toBe('');
    expect(wordmarkBanner(stream({ columns: 51 }))).toBe('');
    expect(wordmarkBanner(stream({ columns: 52 }))).not.toBe('');
    // A pty without a size reports 0 columns, which counts as 80.
    expect(wordmarkBanner(stream({ columns: 0 }))).not.toBe('');
  });
});

describe('playWordmark', () => {
  const sigintListeners = process.listenerCount('SIGINT');
  const sigtermListeners = process.listenerCount('SIGTERM');

  afterEach(() => {
    vi.useRealTimers();
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it('writes nothing to a stream that is not a terminal', async () => {
    const out = stream({ tty: false });
    await playWordmark(out, { env: {} });
    expect(out.writes).toEqual([]);
  });

  it('prints the wordmark at rest, without motion, in CI, on a dumb terminal, when motion is declined, and on a terminal too short to repaint it in place, with a blank line under it', async () => {
    for (const [out, options] of [
      [stream(), { env: { CI: 'true' } }],
      [stream(), { env: { TERM: 'dumb' } }],
      [stream(), { env: {}, motion: false }],
      [stream({ rows: 6 }), { env: {} }],
    ] as const) {
      await playWordmark(out, options);
      expect(out.writes).toEqual([`${REST.join('\n')}\n\n`]);
    }
  });

  it('sweeps a scan line down the logo in about half a second, revealing each row half a row at a time, and leaves it at rest with the cursor shown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.setTimerTickMode('nextTimerAsync');
    const out = stream();
    const started = performance.now();
    await playWordmark(out, { env: {} });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(1000);

    expect(out.writes[0]).toBe(`${ESC}[?25l`);
    expect(out.writes.at(-1)).toBe(`${ESC}[?25h`);
    const paints = out.writes.slice(1, -1);
    expect(paints.length).toBeGreaterThan(10);
    // Every paint is one synchronized update of the six logo rows; every paint after the first erases the one before.
    expect(paints.every((paint) => paint.startsWith(`${ESC}[?2026h`) && paint.endsWith(`${ESC}[?2026l`))).toBe(true);
    expect(paints.slice(1).every((paint) => paint.startsWith(`${ESC}[?2026h${ESC}[6A${ESC}[0J`))).toBe(true);
    const first = stripVTControlCharacters(paints[0]!);
    expect(first.split('\n')).toHaveLength(7);
    // Nothing is ever styled or colored.
    expect(paints.every((paint) => [`${ESC}[0m`, `${ESC}[1m`, `${ESC}[2m`, '38;'].every((style) => !paint.includes(style)))).toBe(true);
    // The scan line sweeps down half a row at a time: each row goes blank, the line alone, its bars' top halves with the line in the gaps, drawn.
    const states = (row: number): readonly string[] => ['', '▔'.repeat(50), REST[row]!.padEnd(50).replaceAll(' ', '▔').replaceAll('█', '▀'), REST[row]!];
    const progress = paints.map((paint) => {
      const lines = stripVTControlCharacters(paint).split('\n').slice(0, REST.length);
      return lines.map((line, row) => states(row).indexOf(line));
    });
    expect(progress.flat().every((state) => state !== -1)).toBe(true);
    // Rows above are always as far along as rows below, and no row ever goes back.
    expect(progress.every((rows) => rows.every((state, row) => row === 0 || state <= rows[row - 1]!))).toBe(true);
    expect(progress.every((rows, index) => index === 0 || rows.every((state, row) => state >= progress[index - 1]![row]!))).toBe(true);
    // Every row passes through the line, its top halves, and drawn, so the line never skips a half row; it starts on the top row.
    expect(REST.every((_, row) => [1, 2, 3].every((state) => progress.some((rows) => rows[row] === state)))).toBe(true);
    expect(progress[0]).toEqual([1, 0, 0, 0, 0, 0]);
    // The last paint is the logo at rest, unstyled, in place, with a blank line under it.
    expect(paints.at(-1)).toBe(`${ESC}[?2026h${ESC}[6A${ESC}[0J${REST.join('\n')}\n\n${ESC}[?2026l`);
  });
});
