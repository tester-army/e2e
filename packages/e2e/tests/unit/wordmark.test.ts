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
  '   ▄▄▄▄▄▄▄▄▄▄     ▄▄▄▄     ▄▄▄▄▄     ▄▄▄▄▄▄▄▄▄▄',
  '   ▀▀▀▀▀▀▀▀▀▀     ▀▀▀▀     ▀▀▀▀▀     ▀▀▀▀▀▀▀▀▀▀',
  ' ████      ████           ████     ████      ████',
  '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄      ▄▄▄▄      ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
  '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀      ▀▀▀▀      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  ' ████              █████          ████',
  '   ▄▄▄▄▄▄▄▄▄▄     ▄▄▄▄▄▄▄▄▄▄▄▄▄▄     ▄▄▄▄▄▄▄▄▄▄',
  '   ▀▀▀▀▀▀▀▀▀▀     ▀▀▀▀▀▀▀▀▀▀▀▀▀▀     ▀▀▀▀▀▀▀▀▀▀',
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
  it('draws the logo at rest as plain half blocks in the terminal foreground', () => {
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
      [stream({ rows: 9 }), { env: {} }],
    ] as const) {
      await playWordmark(out, options);
      expect(out.writes).toEqual([`${REST.join('\n')}\n\n`]);
    }
  });

  it('scans the logo in row by row from the top in under half a second, and leaves it at rest with the cursor shown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.setTimerTickMode('nextTimerAsync');
    const out = stream();
    const started = performance.now();
    await playWordmark(out, { env: {} });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(1000);

    expect(out.writes[0]).toBe(`${ESC}[?25l`);
    expect(out.writes.at(-1)).toBe(`${ESC}[?25h`);
    const paints = out.writes.slice(1, -1);
    expect(paints.length).toBeGreaterThan(10);
    // Every paint is one synchronized update of the nine logo rows; every paint after the first erases the one before.
    expect(paints.every((paint) => paint.startsWith(`${ESC}[?2026h`) && paint.endsWith(`${ESC}[?2026l`))).toBe(true);
    expect(paints.slice(1).every((paint) => paint.startsWith(`${ESC}[?2026h${ESC}[9A${ESC}[0J`))).toBe(true);
    const first = stripVTControlCharacters(paints[0]!);
    expect(first.split('\n')).toHaveLength(10);
    // Nothing is ever styled or colored.
    expect(paints.every((paint) => [`${ESC}[0m`, `${ESC}[1m`, `${ESC}[2m`, '38;'].every((style) => !paint.includes(style)))).toBe(true);
    // Every paint is the logo down to some row and blank below it, and the rows arrive top to bottom.
    const scanned = paints.slice(0, -1).map((paint) => stripVTControlCharacters(paint).split('\n').slice(0, REST.length));
    const reached = scanned.map((lines) => {
      const count = lines.findIndex((line, row) => line !== REST[row]);
      expect(lines.slice(count === -1 ? REST.length : count).every((line) => line === '')).toBe(true);
      return count === -1 ? REST.length : count;
    });
    expect(reached[0]).toBe(1);
    expect(reached.every((count, index) => index === 0 || count >= reached[index - 1]!)).toBe(true);
    expect(reached.at(-1)).toBe(REST.length);
    // The last paint is the logo at rest, unstyled, in place, with a blank line under it.
    expect(paints.at(-1)).toBe(`${ESC}[?2026h${ESC}[9A${ESC}[0J${REST.join('\n')}\n\n${ESC}[?2026l`);
  });
});
