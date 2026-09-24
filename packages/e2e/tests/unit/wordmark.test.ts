import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { playWordmark, wordmarkBanner, type WordmarkStream } from '../../src/cli/wordmark.ts';

const ESC = '\u001b';

const REST = [
  '                     ▗▄▟█████▙▄',
  '                    ▟██▛▀▀▀▀▀███▖',
  '   ▄▟██████▄▖      ▟██▛       ███▖      ▗▄██████▙▄',
  ' ▄███▀▀▀▀▀▜██▙     ▝▀▀        ███▘    ▗▟██▛▀▀▀▀▀███▖',
  '▐██▛       ▐██▌            ▗▄███▀     ███▘       ███',
  '▀▀▀████████████         ▄▟███▛▀      ▝▀▀▜███████████▌',
  '▄▄▄▀▀▀▀▀▀▀▀▀▀▀▀      ▄▟███▀▘         ▗▄▄▞▀▀▀▀▀▀▀▀▀▀▀▘',
  '▐██▙       ▗▄▄▖     ▟██▛▘             ███▖       ▄▄▄',
  ' ▀███▄▄▄▄▄▟██▛     ▟███▄▄▄▄▄▄▄▄▄▄▖    ▝▜██▙▄▄▄▄▄███▘',
  '   ▀▀█████▛▀▘         ▐██████████▘      ▝▀▜█████▀▀',
];

interface FakeStream extends WordmarkStream {
  readonly writes: string[];
}

function stream(options: { tty?: boolean; columns?: number; depth?: number } = {}): FakeStream {
  const writes: string[] = [];
  return {
    writes,
    isTTY: options.tty ?? true,
    columns: options.columns ?? 100,
    write(text: string) {
      writes.push(text);
      return true;
    },
    getColorDepth: () => options.depth ?? 24,
  };
}

describe('wordmarkBanner', () => {
  it('draws the wordmark at rest in the terminal foreground, ending in a blank line', () => {
    const banner = wordmarkBanner(stream());
    expect(stripVTControlCharacters(banner)).toBe(`${REST.join('\n')}\n\n`);
    // The site sets the word in white on dark; the terminal's own foreground is that on any theme, and no orange stays.
    expect(banner).toContain(`${ESC}[39m`);
    expect(banner).not.toContain('38;');
    expect(banner.split('\n').filter((line) => line !== '').every((line) => line.endsWith(`${ESC}[0m`))).toBe(true);
  });

  it('keeps the foreground at every color depth, and prints bare blocks without colors', () => {
    for (const depth of [8, 4]) {
      const banner = wordmarkBanner(stream({ depth }));
      expect(banner).toContain(`${ESC}[39m`);
      expect(banner).not.toContain('38;');
    }
    expect(wordmarkBanner(stream({ depth: 1 }))).toBe(`${REST.join('\n')}\n\n`);
  });

  it('is empty when the output is not a terminal, or a terminal too narrow for it', () => {
    expect(wordmarkBanner(stream({ tty: false }))).toBe('');
    expect(wordmarkBanner(stream({ columns: 54 }))).toBe('');
    expect(wordmarkBanner(stream({ columns: 55 }))).not.toBe('');
    // A pty without a size reports 0 columns, which counts as 80.
    expect(wordmarkBanner(stream({ columns: 0 }))).not.toBe('');
  });
});

describe('playWordmark', () => {
  const sigintListeners = process.listenerCount('SIGINT');

  afterEach(() => {
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
  });

  it('writes nothing to a stream that is not a terminal', async () => {
    const out = stream({ tty: false });
    await playWordmark(out, { env: {} });
    expect(out.writes).toEqual([]);
  });

  it('prints the wordmark at rest, without motion, in CI, on a dumb terminal, and when motion is declined', async () => {
    for (const options of [{ env: { CI: 'true' } }, { env: { TERM: 'dumb' } }, { env: {}, motion: false }]) {
      const out = stream({ depth: 1 });
      await playWordmark(out, options);
      expect(out.writes).toEqual([`${REST.join('\n')}\n\n`]);
    }
  });

  it('drops the pieces in over two seconds or so, repainting in place, flashing the cleared row, and leaves the wordmark at rest with the cursor shown', async () => {
    const out = stream();
    const started = performance.now();
    await playWordmark(out, { env: {} });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThan(1500);
    expect(elapsed).toBeLessThan(4000);

    expect(out.writes[0]).toBe(`${ESC}[?25l`);
    expect(out.writes.at(-1)).toBe(`${ESC}[?25h`);
    const paints = out.writes.slice(1, -1);
    expect(paints.length).toBeGreaterThan(10);
    // Every paint is one synchronized update; every paint after the first erases the thirteen board rows of the one before.
    expect(paints.every((paint) => paint.startsWith(`${ESC}[?2026h`) && paint.endsWith(`${ESC}[?2026l`))).toBe(true);
    expect(paints.slice(1).every((paint) => paint.startsWith(`${ESC}[?2026h${ESC}[13A${ESC}[0J`))).toBe(true);
    const first = stripVTControlCharacters(paints[0]!);
    expect(first.split('\n')).toHaveLength(14);
    // Pieces fall in the brand orange; the full floor row, and later the settled word, take the terminal's own foreground.
    expect(paints.some((paint) => paint.includes(`${ESC}[38;2;255;128;1m`))).toBe(true);
    expect(paints.some((paint) => paint.includes(`${ESC}[39m`))).toBe(true);
    // The last paint replaces the thirteen rows with the ten at rest, in the foreground, and a blank line.
    expect(paints.at(-1)!.startsWith(`${ESC}[?2026h${ESC}[13A${ESC}[0J`)).toBe(true);
    expect(paints.at(-1)).toContain(`${ESC}[39m`);
    expect(paints.at(-1)).not.toContain('38;');
    expect(stripVTControlCharacters(paints.at(-1)!)).toBe(`${REST.join('\n')}\n\n`);
  });
});
