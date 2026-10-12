import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import picocolors from 'picocolors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileGlobList } from '../../src/internal/globs.ts';
import type { RunOptions, RunOutcome } from '../../src/run/runner.ts';
import { SignalLadder } from '../../src/cli/signals.ts';
import {
  bannerText,
  ChangeWatcher,
  classifyChange,
  DEBOUNCE_MS,
  keyOf,
  mergeTriggers,
  NO_FILTERS,
  planRun,
  scopeOf,
  triggerOf,
  watchRoots,
  watchSession,
  type WatchFn,
  type WatchScope,
} from '../../src/cli/watch.ts';

const pc = picocolors.createColors(false);

describe('planRun', () => {
  const base: RunOptions = { files: ['tests/signup.e2e.ts:12'], lastFailed: true, grep: [/checkout/], tags: ['smoke'] };

  it('keeps the command line for the first run, --last-failed included', () => {
    expect(planRun(base, NO_FILTERS, { kind: 'start' })).toBe(base);
  });

  it('runs a changed file whole in place of the positionals, inside the other filters', () => {
    expect(planRun(base, NO_FILTERS, { kind: 'files', files: ['tests/login.e2e.ts'] })).toEqual({
      ...base,
      lastFailed: false,
      files: ['tests/login.e2e.ts'],
    });
  });

  it('keeps the positionals on a config change and on enter, under the p and t filters', () => {
    expect(planRun(base, NO_FILTERS, { kind: 'config' })).toEqual({ ...base, lastFailed: false });
    const filters = { file: 'login', title: /signs in/ };
    expect(planRun(base, filters, { kind: 'key', key: 'enter' })).toEqual({ ...base, lastFailed: false, files: ['login'], grep: [/signs in/] });
  });

  it('a and u run everything the command line selected; f reruns the last report', () => {
    const filters = { file: 'login', title: /signs in/ };
    expect(planRun(base, filters, { kind: 'key', key: 'a' })).toEqual({ ...base, lastFailed: false });
    expect(planRun(base, filters, { kind: 'key', key: 'u' })).toEqual({ ...base, lastFailed: false, updateSnapshots: true });
    expect(planRun(base, filters, { kind: 'key', key: 'f' })).toEqual({ ...base, lastFailed: true, passWithNoTests: true, files: ['login'], grep: [/signs in/] });
  });
});

describe('classifyChange and watchRoots', () => {
  let root: string;
  let scope: WatchScope;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'e2e-watch-'));
    mkdirSync(path.join(root, 'tests', 'agent'), { recursive: true });
    scope = { projectRoot: root, configPath: path.join(root, 'e2e.config.ts'), tests: ['tests/**/*.e2e.ts', '!tests/wip/**'] };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('names a test file by its project-relative path, the config as the config, and nothing else', () => {
    const globs = compileGlobList(scope.tests);
    expect(classifyChange(scope, globs, path.join(root, 'tests', 'agent', 'signup.e2e.ts'))).toEqual({ kind: 'test', file: 'tests/agent/signup.e2e.ts' });
    expect(classifyChange(scope, globs, path.join(root, 'e2e.config.ts'))).toEqual({ kind: 'config' });
    expect(classifyChange(scope, globs, path.join(root, 'tests', 'helpers.ts'))).toBeUndefined();
    expect(classifyChange(scope, globs, path.join(root, 'tests', 'wip', 'draft.e2e.ts'))).toBeUndefined();
    expect(classifyChange(scope, globs, path.join(root, '..', 'other', 'tests', 'x.e2e.ts'))).toBeUndefined();
  });

  it('watches the literal prefix of each glob recursively and the config directory flat', () => {
    expect(watchRoots(scope, compileGlobList(scope.tests))).toEqual([
      { dir: path.join(root, 'tests'), recursive: true },
      { dir: root, recursive: false },
    ]);
  });

  it('climbs to the nearest existing directory and drops roots a recursive one covers', () => {
    const nested: WatchScope = { ...scope, tests: ['tests/later/**/*.e2e.ts', 'tests/agent/*.e2e.ts', '**/*.spec.e2e.ts'] };
    expect(watchRoots(nested, compileGlobList(nested.tests))).toEqual([{ dir: root, recursive: true }]);
    const two: WatchScope = { ...scope, tests: ['tests/later/**/*.e2e.ts', 'tests/agent/*.e2e.ts'] };
    expect(watchRoots(two, compileGlobList(two.tests))).toEqual([
      { dir: path.join(root, 'tests'), recursive: true },
      { dir: root, recursive: false },
    ]);
    mkdirSync(path.join(root, 'spec'));
    const apart: WatchScope = { ...scope, configPath: undefined, tests: ['tests/agent/*.e2e.ts', 'spec/**/*.e2e.ts'] };
    expect(watchRoots(apart, compileGlobList(apart.tests))).toEqual([
      { dir: path.join(root, 'tests', 'agent'), recursive: true },
      { dir: path.join(root, 'spec'), recursive: true },
    ]);
  });

  it('a literal glob watches the file\'s directory', () => {
    const literal: WatchScope = { ...scope, configPath: undefined, tests: ['tests/agent/signup.e2e.ts'] };
    expect(watchRoots(literal, compileGlobList(literal.tests))).toEqual([{ dir: path.join(root, 'tests', 'agent'), recursive: true }]);
  });

  it('triggerOf runs the files that still exist, and the config over them', () => {
    writeFileSync(path.join(root, 'tests', 'a.e2e.ts'), '');
    expect(triggerOf(scope, { files: ['tests/a.e2e.ts', 'tests/gone.e2e.ts'], config: false })).toEqual({ kind: 'files', files: ['tests/a.e2e.ts'] });
    expect(triggerOf(scope, { files: ['tests/gone.e2e.ts'], config: false })).toBeUndefined();
    expect(triggerOf(scope, { files: ['tests/a.e2e.ts'], config: true })).toEqual({ kind: 'config' });
  });
});

describe('ChangeWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports one debounced burst with the test files touched, sorted, and whether the config was', () => {
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const closed: string[] = [];
    const watch: WatchFn = (dir, _options, listener) => {
      listeners.set(dir, listener);
      return { close: () => closed.push(dir) };
    };
    const scope: WatchScope = { projectRoot: '/p', configPath: '/p/e2e.config.ts', tests: ['tests/**/*.e2e.ts'] };
    const bursts: unknown[] = [];
    const watcher = new ChangeWatcher(scope, (changes) => bursts.push(changes), watch);
    expect(watcher.start()).toEqual([
      { dir: '/p', recursive: true },
    ]);
    const emit = listeners.get('/p')!;
    emit('change', 'tests/b.e2e.ts');
    emit('rename', 'tests/a.e2e.ts');
    emit('change', 'tests/helpers.ts');
    emit('change', 'tests/a.e2e.ts');
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(bursts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(bursts).toEqual([{ files: ['tests/a.e2e.ts', 'tests/b.e2e.ts'], config: false }]);
    emit('change', 'e2e.config.ts');
    emit('change', null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(bursts).toEqual([
      { files: ['tests/a.e2e.ts', 'tests/b.e2e.ts'], config: false },
      { files: [], config: true },
    ]);
    watcher.close();
    expect(closed).toEqual(['/p']);
  });

  it('a root that cannot be watched is left out', () => {
    const watch: WatchFn = () => {
      throw new Error('ENOSPC');
    };
    const watcher = new ChangeWatcher({ projectRoot: '/p', configPath: undefined, tests: ['tests/**/*.e2e.ts'] }, () => undefined, watch);
    expect(watcher.start()).toEqual([]);
  });
});

describe('triggers and keys', () => {
  it('merges file bursts and lets a config change or a key stand', () => {
    expect(mergeTriggers({ kind: 'files', files: ['b'] }, { kind: 'files', files: ['a', 'b'] })).toEqual({ kind: 'files', files: ['a', 'b'] });
    expect(mergeTriggers({ kind: 'files', files: ['b'] }, { kind: 'config' })).toEqual({ kind: 'config' });
    expect(mergeTriggers({ kind: 'config' }, { kind: 'files', files: ['b'] })).toEqual({ kind: 'config' });
    expect(mergeTriggers({ kind: 'key', key: 'f' }, { kind: 'files', files: ['b'] })).toEqual({ kind: 'key', key: 'f' });
  });

  it('maps keypresses, Ctrl-C included', () => {
    expect(keyOf({ name: 'return', ctrl: false })).toBe('enter');
    expect(keyOf({ name: 'a', ctrl: false })).toBe('a');
    expect(keyOf({ name: 'c', ctrl: true })).toBe('interrupt');
    expect(keyOf({ name: 'd', ctrl: true })).toBe('interrupt');
    expect(keyOf({ name: 'a', ctrl: true })).toBeUndefined();
    expect(keyOf({ name: 'x', ctrl: false })).toBeUndefined();
  });

  it('banners name the trigger and the filters', () => {
    expect(bannerText(pc, { kind: 'files', files: ['tests/a.e2e.ts'] }, NO_FILTERS, 2)).toBe(' RERUN  tests/a.e2e.ts x2\n\n');
    expect(bannerText(pc, { kind: 'key', key: 'f' }, { file: 'login', title: /x/ }, 3)).toBe(' RERUN  failed tests (files: login, title: x) x3\n\n');
    expect(bannerText(pc, { kind: 'config' }, NO_FILTERS, 4)).toBe(' RERUN  config changed x4\n\n');
  });

  it('scopeOf reads the run config, else the discovered config file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'e2e-watch-'));
    try {
      writeFileSync(path.join(root, 'e2e.config.ts'), '');
      const failed = { config: undefined } as unknown as RunOutcome;
      expect(scopeOf(failed, root, undefined)).toEqual({ projectRoot: root, configPath: path.join(root, 'e2e.config.ts'), tests: [] });
      expect(scopeOf(failed, root, 'missing.config.ts')).toEqual({ projectRoot: root, configPath: undefined, tests: [] });
      const loaded = { config: { projectRoot: '/p', configPath: '/p/e2e.config.ts', tests: ['t/**'] } } as unknown as RunOutcome;
      expect(scopeOf(loaded, root, undefined)).toEqual({ projectRoot: '/p', configPath: '/p/e2e.config.ts', tests: ['t/**'] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('watchSession', () => {
  let root: string;
  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(path.join(tmpdir(), 'e2e-watch-'));
    mkdirSync(path.join(root, 'tests'));
    writeFileSync(path.join(root, 'tests', 'a.e2e.ts'), '');
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs, reruns the changed file after the run that was in flight, and ends on the interrupt with the last exit code', async () => {
    const listeners: ((event: string, filename: string | null) => void)[] = [];
    const watch: WatchFn = (_dir, _options, listener) => {
      listeners.push(listener);
      return { close: () => undefined };
    };
    const runs: RunOptions[] = [];
    let release: (() => void) | undefined;
    const exitCodes = [1, 1, 0];
    const run = async (options: RunOptions): Promise<RunOutcome> => {
      runs.push(options);
      // The second run waits, so a change can land while it is in flight.
      if (runs.length === 2) await new Promise<void>((resolve) => (release = resolve));
      return {
        exitCode: exitCodes[runs.length - 1]!,
        config: { projectRoot: root, configPath: path.join(root, 'e2e.config.ts'), tests: ['tests/**/*.e2e.ts'] },
      } as unknown as RunOutcome;
    };
    const written: string[] = [];
    const signals = new SignalLadder();
    const session = watchSession({
      base: { files: [], configPath: undefined, lastFailed: true },
      cwd: root,
      signals,
      run,
      stdin: undefined,
      write: (text) => written.push(text),
      pc,
      clear: false,
      watch,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual([{ files: [], configPath: undefined, lastFailed: true }]);
    // The tests directory, recursively, and the config's directory, flat.
    expect(listeners).toHaveLength(2);
    expect(written.join('')).toContain('Waiting for file changes...');

    // The first watcher is the tests directory; file names arrive relative to it.
    listeners[0]!('change', 'a.e2e.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual({ files: ['tests/a.e2e.ts'], configPath: undefined, lastFailed: false, grep: undefined });
    expect(written.join('')).toContain(' RERUN  tests/a.e2e.ts x2');

    // A change during the run waits for it, then runs.
    writeFileSync(path.join(root, 'tests', 'b.e2e.ts'), '');
    listeners[0]!('change', 'b.e2e.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(runs).toHaveLength(2);
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(3);
    expect(runs[2]!.files).toEqual(['tests/b.e2e.ts']);

    signals.escalate(() => undefined);
    await expect(session).resolves.toBe(0);
  });

  it('ends after a run the interrupt cut short, with its exit code', async () => {
    const signals = new SignalLadder();
    const run = async (): Promise<RunOutcome> => {
      signals.escalate(() => undefined);
      return { exitCode: 130, config: undefined } as unknown as RunOutcome;
    };
    const exit = await watchSession({
      base: {},
      cwd: root,
      signals,
      run,
      stdin: undefined,
      write: () => undefined,
      pc,
      clear: false,
      watch: () => ({ close: () => undefined }),
    });
    expect(exit).toBe(130);
  });
});
