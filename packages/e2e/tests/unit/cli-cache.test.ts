/** `e2e cache ls`, `clear`, and `stats` over a real store directory. */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTraceCacheStore, MAX_CACHE_WIRE_BYTES } from '../../src/cache/store.ts';
import { main } from '../../src/cli/index.ts';
import type { ActionTrace, TraceProvenance } from '../../src/cache/trace.ts';

let root: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

const CACHE_DIR = 'store';

function written(spy: ReturnType<typeof vi.spyOn>): string {
  return stripVTControlCharacters(spy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join(''));
}

function writeConfig(body: string): void {
  writeFileSync(path.join(root, 'e2e.config.ts'), body, 'utf8');
}

/** The default config of these tests: one target, cache in `store/`. */
function writeDefaultConfig(): void {
  writeConfig(
    `export default { targets: [{ name: 'web', platform: 'web' }], cache: { dir: ${JSON.stringify(CACHE_DIR)} } };\n`,
  );
}

function trace(recordedFor: TraceProvenance | undefined, actions: number): ActionTrace {
  return {
    actions: Array.from({ length: actions }, (_, index) => ({
      name: 'tap' as const,
      summary: `tap ${index}`,
      target: { role: 'button', name: `Button ${index}` },
    })),
    executor: { name: 'example-agent' },
    ...(recordedFor === undefined ? {} : { recordedFor }),
    summary: 'step passed',
  };
}

async function seed(entries: readonly { keyHash: string; trace: ActionTrace }[]): Promise<void> {
  const store = new FileTraceCacheStore({
    directory: path.join(root, CACHE_DIR),
    maxBytes: MAX_CACHE_WIRE_BYTES,
    writable: true,
  });
  for (const entry of entries) await store.write(entry.keyHash, entry.trace);
}

async function invoke(...args: string[]): Promise<void> {
  await main(['node', 'e2e', ...args, '--config', path.join(root, 'e2e.config.ts')]);
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'e2e-cache-cli-'));
  // The config loader reads .ts config only from an ES module project.
  writeFileSync(path.join(root, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeDefaultConfig();
  process.exitCode = undefined;
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('e2e cache ls', () => {
  it('prints the provenance, age, and action count of every entry', async () => {
    await seed([
      {
        keyHash: 'a'.repeat(64),
        trace: trace({ testId: 'tests/signup.e2e.ts::signs up', targetId: 'web', instructionDigest: 'd'.repeat(64) }, 3),
      },
      {
        keyHash: 'b'.repeat(64),
        trace: trace({ testId: 'tests/billing.e2e.ts::upgrades', targetId: 'safari', instructionDigest: 'e'.repeat(64) }, 1),
      },
    ]);
    await invoke('cache', 'ls');
    const lines = written(stdoutSpy).trimEnd().split('\n');
    expect(process.exitCode).toBe(0);
    expect(lines[0]).toMatch(/^TEST +TARGET +INSTRUCTION +AGE +ACTIONS$/);
    // Sorted by test, so billing precedes signup whatever the file order was.
    expect(lines[1]).toMatch(/^tests\/billing\.e2e\.ts::upgrades +safari +eeeeeeeeeeee +<1m +1$/);
    expect(lines[2]).toMatch(/^tests\/signup\.e2e\.ts::signs up +web +dddddddddddd +<1m +3$/);
  });

  it('prints a dash for an entry recorded before entries described themselves', async () => {
    await seed([{ keyHash: 'a'.repeat(64), trace: trace(undefined, 2) }]);
    await invoke('cache', 'ls');
    expect(written(stdoutSpy).trimEnd().split('\n')[1]).toMatch(/^- +- +- +<1m +2$/);
  });

  it('marks a recording the action cap cut short', async () => {
    await seed([{ keyHash: 'b'.repeat(64), trace: { ...trace(undefined, 2), truncated: true } }]);
    await invoke('cache', 'ls');
    expect(written(stdoutSpy).trimEnd().split('\n')[1]).toMatch(/ 2 \(truncated\)$/);
  });

  it('reports an empty store instead of failing', async () => {
    await invoke('cache', 'ls');
    expect(written(stdoutSpy)).toContain('no trace cache entries in');
    expect(process.exitCode).toBe(0);
  });

  it('counts a file the store cannot read as unreadable, not as an entry', async () => {
    mkdirSync(path.join(root, CACHE_DIR), { recursive: true });
    writeFileSync(path.join(root, CACHE_DIR, `${'c'.repeat(64)}.json`), '{ not json', 'utf8');
    await invoke('cache', 'ls');
    expect(written(stdoutSpy)).toContain('no trace cache entries in');
    expect(written(stderrSpy)).toContain('are not readable trace-1 entries');
  });
});

describe('e2e cache stats', () => {
  it('prints the directory, the entry count, and the size', async () => {
    await seed([
      { keyHash: 'a'.repeat(64), trace: trace(undefined, 1) },
      { keyHash: 'b'.repeat(64), trace: trace(undefined, 1) },
    ]);
    await invoke('cache', 'stats');
    const output = written(stdoutSpy);
    expect(output).toContain(`directory  ${path.join(root, CACHE_DIR)}`);
    expect(output).toContain('entries    2');
    expect(output).toMatch(/size {7}\d+(\.\d)? (B|KiB)/);
  });

  it('reports a store that was never written as empty', async () => {
    await invoke('cache', 'stats');
    expect(written(stdoutSpy)).toContain('entries    0');
    expect(written(stdoutSpy)).toContain('size       0 B');
  });
});

describe('e2e cache clear', () => {
  it('deletes the entries and the directory', async () => {
    await seed([
      { keyHash: 'a'.repeat(64), trace: trace(undefined, 1) },
      { keyHash: 'b'.repeat(64), trace: trace(undefined, 1) },
    ]);
    await invoke('cache', 'clear');
    expect(written(stdoutSpy)).toContain('cleared 2 file(s)');
    expect(readdirSync(root).toSorted()).toEqual(['e2e.config.ts', 'package.json']);
    expect(process.exitCode).toBe(0);
  });

  it('removes an unreadable entry and a crashed writer\u2019s temporary file', async () => {
    const directory = path.join(root, CACHE_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${'c'.repeat(64)}.json`), 'torn', 'utf8');
    writeFileSync(path.join(directory, `${'d'.repeat(64)}.json.0123456789abcdef.tmp`), '{}', 'utf8');
    await invoke('cache', 'clear');
    expect(written(stdoutSpy)).toContain('cleared 2 file(s)');
  });

  it('leaves files the runner never wrote, and says so', async () => {
    const directory = path.join(root, CACHE_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'notes.md'), 'keep me', 'utf8');
    await invoke('cache', 'clear');
    expect(written(stderrSpy)).toContain('notes.md');
    expect(readdirSync(directory)).toEqual(['notes.md']);
  });

  it('has nothing to clear when the store was never written', async () => {
    await invoke('cache', 'clear');
    expect(written(stdoutSpy)).toContain('no trace cache entries to clear');
    expect(process.exitCode).toBe(0);
  });
});

describe('e2e cache configuration', () => {
  it('refuses a custom store it cannot enumerate', async () => {
    writeConfig(
      [
        "const store = { writable: false, read: async () => ({ status: 'miss' }), write: async () => undefined };",
        "export default { targets: [{ name: 'web', platform: 'web' }], cache: { store } };",
        '',
      ].join('\n'),
    );
    await invoke('cache', 'stats');
    expect(written(stderrSpy)).toContain('cache.store replaces the file store');
    expect(process.exitCode).toBe(2);
  });

  it('fails with the config error when the config is missing', async () => {
    rmSync(path.join(root, 'e2e.config.ts'));
    await invoke('cache', 'ls');
    expect(written(stderrSpy)).toContain('config file not found');
    expect(process.exitCode).toBe(2);
  });
});
