import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
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
  triggerOf,
  watchRoots,
  watchSession,
  type RootWatcher,
  type RunCancel,
  type WatchFn,
  type WatchScope,
} from '../../src/cli/watch.ts';

const CANCEL = Symbol('cancel');
const textMock = vi.hoisted(() => vi.fn());
vi.mock('@clack/prompts', () => ({ text: textMock, isCancel: (value: unknown) => value === CANCEL }));

const pc = picocolors.createColors(false);

/** A watcher stand-in that remembers its listeners by root and reports closes. */
function fakeWatch(listeners: Map<string, (event: string, filename: string | null) => void>, closed: string[] = []): WatchFn {
  return (dir, _options, listener) => {
    listeners.set(dir, listener);
    return { close: () => closed.push(dir), on: () => undefined };
  };
}

/** A stdin stand-in: keys arrive as writes, raw mode is recorded. */
function fakeStdin(): NodeJS.ReadStream & { setRawMode: ReturnType<typeof vi.fn> } {
  const setRawMode = vi.fn();
  return Object.assign(new PassThrough(), { setRawMode }) as unknown as NodeJS.ReadStream & { setRawMode: typeof setRawMode };
}

describe('planRun', () => {
  const base: RunOptions = { files: ['tests/signup.e2e.ts:12'], lastFailed: true, changedSince: 'origin/main', grep: [/checkout/], tags: ['smoke'] };
  const rerun = { ...base, freshGraph: true, lastFailed: false, changedSince: undefined, passWithNoTests: true };

  it('keeps the command line for the first run, --last-failed and --changed-since included, with the project files read afresh', () => {
    expect(planRun(base, NO_FILTERS, { kind: 'start' })).toEqual({ ...base, freshGraph: true });
  });

  it('runs a changed file whole in place of the positionals, inside the other filters; a source change runs the selection', () => {
    expect(planRun(base, NO_FILTERS, { kind: 'files', files: ['tests/login.e2e.ts'] })).toEqual({ ...rerun, files: ['tests/login.e2e.ts'] });
    expect(planRun(base, NO_FILTERS, { kind: 'source', files: ['tests/helpers.ts'] })).toEqual(rerun);
  });

  it('keeps the positionals on a config change and on r, under the p and t filters', () => {
    expect(planRun(base, NO_FILTERS, { kind: 'config' })).toEqual(rerun);
    const filters = { file: 'login', title: /signs in/ };
    expect(planRun(base, filters, { kind: 'key', key: 'r' })).toEqual({ ...rerun, files: ['login'], grep: [/signs in/] });
    expect(planRun(base, filters, { kind: 'config' })).toEqual({ ...rerun, files: ['login'], grep: [/signs in/] });
  });

  it('a runs everything the command line selected; u updates the current pattern; f reruns the last report', () => {
    const filters = { file: 'login', title: /signs in/ };
    expect(planRun(base, filters, { kind: 'key', key: 'a' })).toEqual(rerun);
    expect(planRun(base, filters, { kind: 'key', key: 'u' })).toEqual({ ...rerun, updateSnapshots: true, files: ['login'], grep: [/signs in/] });
    expect(planRun(base, filters, { kind: 'key', key: 'f' })).toEqual({ ...rerun, lastFailed: true, files: [], grep: [/signs in/] });
  });
});

describe('classifyChange and watchRoots', () => {
  let root: string;
  let scope: WatchScope;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'e2e-watch-'));
    mkdirSync(path.join(root, 'tests', 'agent'), { recursive: true });
    scope = {
      projectRoot: root,
      configPath: path.join(root, 'e2e.config.ts'),
      tests: ['tests/**/*.e2e.ts', '!tests/wip/**'],
      written: [path.join(root, 'test-results'), path.join(root, 'tests', 'cache')],
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('names a test file, a source file a test could import, the config, and nothing under node_modules, a dot directory, or what the run writes', () => {
    const globs = compileGlobList(scope.tests);
    const at = (...segments: string[]) => classifyChange(scope, globs, path.join(root, ...segments));
    expect(at('tests', 'agent', 'signup.e2e.ts')).toEqual({ kind: 'test', file: 'tests/agent/signup.e2e.ts' });
    expect(at('e2e.config.ts')).toEqual({ kind: 'config' });
    expect(at('tests', 'helpers.ts')).toEqual({ kind: 'source', file: 'tests/helpers.ts' });
    expect(at('tests', 'fixtures', 'users.json')).toEqual({ kind: 'source', file: 'tests/fixtures/users.json' });
    expect(at('tests', 'README.md')).toBeUndefined();
    expect(at('tests', 'wip', 'draft.e2e.ts')).toBeUndefined();
    expect(at('node_modules', 'pkg', 'x.e2e.ts')).toBeUndefined();
    expect(at('.e2e', 'results', 'x.ts')).toBeUndefined();
    expect(at('test-results', 'report.json')).toBeUndefined();
    expect(at('tests', 'cache', 'abc.json')).toBeUndefined();
    expect(at('..', 'other', 'tests', 'x.e2e.ts')).toBeUndefined();
  });

  it('a glob from the project root watches the root flat and its directories, not node_modules or dot directories', () => {
    mkdirSync(path.join(root, 'node_modules'));
    mkdirSync(path.join(root, '.e2e'));
    mkdirSync(path.join(root, 'test-results'));
    mkdirSync(path.join(root, 'src'));
    const wide: WatchScope = { ...scope, tests: ['**/*.e2e.ts'] };
    expect(watchRoots(wide, compileGlobList(wide.tests))).toEqual([
      { dir: root, recursive: false },
      { dir: path.join(root, 'src'), recursive: true },
      { dir: path.join(root, 'tests'), recursive: true },
    ]);
  });

  it('watches the literal prefix of each glob, climbed to the nearest existing directory, and the config directory flat', () => {
    const two: WatchScope = { ...scope, tests: ['tests/later/**/*.e2e.ts', 'tests/agent/*.e2e.ts'] };
    expect(watchRoots(two, compileGlobList(two.tests))).toEqual([
      { dir: path.join(root, 'tests'), recursive: true },
      { dir: root, recursive: false },
    ]);
    const missing: WatchScope = { ...scope, tests: ['spec/**/*.e2e.ts'] };
    expect(watchRoots(missing, compileGlobList(missing.tests))).toEqual([
      { dir: root, recursive: false },
      { dir: path.join(root, 'tests'), recursive: true },
    ]);
    mkdirSync(path.join(root, 'spec'));
    const apart: WatchScope = { ...scope, configPath: undefined, tests: ['tests/agent/*.e2e.ts', 'spec/**/*.e2e.ts'] };
    expect(watchRoots(apart, compileGlobList(apart.tests))).toEqual([
      { dir: path.join(root, 'tests', 'agent'), recursive: true },
      { dir: path.join(root, 'spec'), recursive: true },
    ]);
  });

  it("a literal glob watches the file's directory", () => {
    const literal: WatchScope = { ...scope, configPath: undefined, tests: ['tests/agent/signup.e2e.ts'] };
    expect(watchRoots(literal, compileGlobList(literal.tests))).toEqual([{ dir: path.join(root, 'tests', 'agent'), recursive: true }]);
  });

  it('triggerOf runs the files that still exist, a source change over them, and the config over everything', () => {
    writeFileSync(path.join(root, 'tests', 'a.e2e.ts'), '');
    writeFileSync(path.join(root, 'tests', 'helpers.ts'), '');
    expect(triggerOf(scope, { files: ['tests/a.e2e.ts', 'tests/gone.e2e.ts'], sources: [], config: false })).toEqual({ kind: 'files', files: ['tests/a.e2e.ts'] });
    expect(triggerOf(scope, { files: ['tests/gone.e2e.ts'], sources: ['tests/gone.ts'], config: false })).toBeUndefined();
    expect(triggerOf(scope, { files: ['tests/a.e2e.ts'], sources: ['tests/helpers.ts'], config: false })).toEqual({ kind: 'source', files: ['tests/helpers.ts'] });
    expect(triggerOf(scope, { files: ['tests/a.e2e.ts'], sources: [], config: true })).toEqual({ kind: 'config' });
  });
});

describe('ChangeWatcher', () => {
  let root: string;
  let scope: WatchScope;
  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(path.join(tmpdir(), 'e2e-watch-'));
    mkdirSync(path.join(root, 'tests'));
    scope = { projectRoot: root, configPath: path.join(root, 'e2e.config.ts'), tests: ['tests/**/*.e2e.ts'], written: [] };
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports one debounced burst with the test and source files touched, sorted, and whether the config was', () => {
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const closed: string[] = [];
    const bursts: unknown[] = [];
    const watcher = new ChangeWatcher(scope, (changes) => bursts.push(changes), () => undefined, fakeWatch(listeners, closed));
    expect(watcher.start()).toEqual([
      { dir: path.join(root, 'tests'), recursive: true },
      { dir: root, recursive: false },
    ]);
    const emit = listeners.get(path.join(root, 'tests'))!;
    emit('change', 'b.e2e.ts');
    emit('rename', 'a.e2e.ts');
    emit('change', 'helpers.ts');
    emit('change', 'notes.md');
    emit('change', 'a.e2e.ts');
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(bursts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(bursts).toEqual([{ files: ['tests/a.e2e.ts', 'tests/b.e2e.ts'], sources: ['tests/helpers.ts'], config: false }]);
    listeners.get(root)!('change', 'e2e.config.ts');
    emit('change', null);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(bursts).toHaveLength(2);
    expect(bursts[1]).toEqual({ files: [], sources: [], config: true });
    watcher.close();
    expect(closed).toEqual([path.join(root, 'tests'), root]);
  });

  it('close drops a burst still pending', () => {
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const bursts: unknown[] = [];
    const watcher = new ChangeWatcher(scope, (changes) => bursts.push(changes), () => undefined, fakeWatch(listeners));
    watcher.start();
    listeners.get(path.join(root, 'tests'))!('change', 'a.e2e.ts');
    watcher.close();
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(bursts).toEqual([]);
  });

  it('a directory made under the flat root is watched from then on', () => {
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const closed: string[] = [];
    const wide: WatchScope = { ...scope, tests: ['**/*.e2e.ts'] };
    const watcher = new ChangeWatcher(wide, () => undefined, () => undefined, fakeWatch(listeners, closed));
    expect(watcher.start()).toEqual([
      { dir: root, recursive: false },
      { dir: path.join(root, 'tests'), recursive: true },
    ]);
    mkdirSync(path.join(root, 'spec'));
    listeners.get(root)!('rename', 'spec');
    expect(closed).toEqual([root, path.join(root, 'tests')]);
    expect([...listeners.keys()]).toContain(path.join(root, 'spec'));
    watcher.close();
  });

  it('a root that cannot be watched is left out, and one whose watch fails later is dropped and named', () => {
    const throwing: WatchFn = () => {
      throw new Error('ENOSPC');
    };
    const lostAtOnce: string[] = [];
    expect(new ChangeWatcher(scope, () => undefined, (dir, error) => lostAtOnce.push(`${dir}: ${error.message}`), throwing).start()).toEqual([]);
    expect(lostAtOnce).toEqual([`${path.join(root, 'tests')}: ENOSPC`, `${root}: ENOSPC`]);

    const errors = new Map<string, (error: Error) => void>();
    const closed: string[] = [];
    const lost: string[] = [];
    const failing: WatchFn = (dir) => {
      const watcher: RootWatcher = {
        close: () => closed.push(dir),
        on: (_event, listener) => errors.set(dir, listener),
      };
      return watcher;
    };
    const watcher = new ChangeWatcher(scope, () => undefined, (dir, error) => lost.push(`${dir}: ${error.message}`), failing);
    watcher.start();
    errors.get(path.join(root, 'tests'))!(new Error('ENOSPC: System limit for number of file watchers reached'));
    expect(closed).toEqual([path.join(root, 'tests')]);
    expect(lost).toEqual([`${path.join(root, 'tests')}: ENOSPC: System limit for number of file watchers reached`]);
    watcher.close();
    expect(closed).toEqual([path.join(root, 'tests'), root]);
  });
});

describe('triggers and keys', () => {
  it('merges bursts of a kind and lets the wider trigger stand', () => {
    expect(mergeTriggers({ kind: 'files', files: ['b'] }, { kind: 'files', files: ['a', 'b'] })).toEqual({ kind: 'files', files: ['a', 'b'] });
    expect(mergeTriggers({ kind: 'source', files: ['h'] }, { kind: 'source', files: ['g'] })).toEqual({ kind: 'source', files: ['g', 'h'] });
    expect(mergeTriggers({ kind: 'files', files: ['b'] }, { kind: 'source', files: ['h'] })).toEqual({ kind: 'source', files: ['h'] });
    expect(mergeTriggers({ kind: 'files', files: ['b'] }, { kind: 'config' })).toEqual({ kind: 'config' });
    expect(mergeTriggers({ kind: 'config' }, { kind: 'files', files: ['b'] })).toEqual({ kind: 'config' });
    expect(mergeTriggers({ kind: 'key', key: 'f' }, { kind: 'files', files: ['b'] })).toEqual({ kind: 'key', key: 'f' });
    expect(mergeTriggers({ kind: 'start' }, { kind: 'files', files: ['b'] })).toEqual({ kind: 'files', files: ['b'] });
  });

  it('maps keypresses: enter is a, escape and Ctrl-C interrupt, Ctrl-Z suspends', () => {
    expect(keyOf({ name: 'return', ctrl: false })).toBe('a');
    expect(keyOf({ name: 'a', ctrl: false })).toBe('a');
    expect(keyOf({ name: 'r', ctrl: false })).toBe('r');
    expect(keyOf({ name: 'space', ctrl: false })).toBe('cancel');
    expect(keyOf({ name: 'c', ctrl: false })).toBe('cancel');
    expect(keyOf({ name: 'escape', ctrl: false })).toBe('interrupt');
    expect(keyOf({ name: 'c', ctrl: true })).toBe('interrupt');
    expect(keyOf({ name: 'd', ctrl: true })).toBe('interrupt');
    expect(keyOf({ name: 'z', ctrl: true })).toBe('suspend');
    expect(keyOf({ name: 'a', ctrl: true })).toBeUndefined();
    expect(keyOf({ name: 'x', ctrl: false })).toBeUndefined();
  });

  it('banners name the trigger and the filters', () => {
    expect(bannerText(pc, { kind: 'files', files: ['tests/a.e2e.ts'] }, NO_FILTERS, 2)).toBe(' RERUN  tests/a.e2e.ts x2\n\n');
    expect(bannerText(pc, { kind: 'source', files: ['tests/helpers.ts'] }, NO_FILTERS, 2)).toBe(' RERUN  tests/helpers.ts x2\n\n');
    expect(bannerText(pc, { kind: 'key', key: 'f' }, { file: 'login', title: /x/ }, 3)).toBe(' RERUN  failed tests (files: login, title: x) x3\n\n');
    expect(bannerText(pc, { kind: 'config' }, NO_FILTERS, 4)).toBe(' RERUN  config changed x4\n\n');
  });
});

describe('watchSession', () => {
  let root: string;
  let configPath: string;
  const loaded = (): RunOutcome['config'] =>
    ({ projectRoot: root, configPath, tests: ['tests/**/*.e2e.ts'], reporters: ['list'], output: '.e2e', cache: { dir: path.join(root, '.e2e', 'cache') } }) as unknown as RunOutcome['config'];
  /** A run's outcome: `config` is the loaded one unless the run is one whose config failed to load. */
  const outcome = (exitCode: number, config: RunOutcome['config']): RunOutcome => ({ exitCode, config }) as unknown as RunOutcome;
  const passed = (exitCode = 0): RunOutcome => outcome(exitCode, loaded());
  /** Lets the session's microtasks settle without a timer firing. */
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    textMock.mockReset();
    root = mkdtempSync(path.join(tmpdir(), 'e2e-watch-'));
    configPath = path.join(root, 'e2e.config.ts');
    mkdirSync(path.join(root, 'tests'));
    writeFileSync(path.join(root, 'tests', 'a.e2e.ts'), '');
    writeFileSync(configPath, '');
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs, reruns the changed file after the run that was in flight, and ends on the interrupt with the last exit code', async () => {
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const closed: string[] = [];
    const runs: RunOptions[] = [];
    let release: (() => void) | undefined;
    const exitCodes = [1, 1, 3];
    const run = async (options: RunOptions): Promise<RunOutcome> => {
      runs.push(options);
      // The second run waits, so a change can land while it is in flight.
      if (runs.length === 2) await new Promise<void>((resolve) => (release = resolve));
      return passed(exitCodes[runs.length - 1]!);
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
      writeError: (text) => written.push(text),
      pc,
      clear: true,
      watch: fakeWatch(listeners, closed),
    });
    await settle();
    expect(runs).toEqual([{ files: [], configPath: undefined, lastFailed: true, freshGraph: true }]);
    // The config's directory from the start, flat; the tests directory, recursively, once the config loaded.
    expect(closed).toEqual([root]);
    expect([...listeners.keys()]).toEqual([root, path.join(root, 'tests')]);
    expect(written.join('')).toContain('Waiting for file changes...');

    // File names arrive relative to the watched root.
    listeners.get(path.join(root, 'tests'))!('change', 'a.e2e.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toEqual({ files: ['tests/a.e2e.ts'], configPath: undefined, lastFailed: false, passWithNoTests: true, freshGraph: true });
    expect(written).toContain('\x1b[2J\x1b[3J\x1b[H RERUN  tests/a.e2e.ts x2\n\n');

    // A change during the run waits for it, then runs.
    writeFileSync(path.join(root, 'tests', 'b.e2e.ts'), '');
    listeners.get(path.join(root, 'tests'))!('change', 'b.e2e.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(runs).toHaveLength(2);
    release!();
    await settle();
    expect(runs).toHaveLength(3);
    expect(runs[2]!.files).toEqual(['tests/b.e2e.ts']);
    // The scope did not change: the watcher stayed.
    expect(closed).toEqual([root]);

    signals.escalate(() => undefined);
    await expect(session).resolves.toBe(3);
    expect(closed).toEqual([root, path.join(root, 'tests'), root]);
  });

  it('a config change reruns the selection; a config that then fails to load swaps the watcher for the config file alone', async () => {
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const closed: string[] = [];
    const runs: RunOptions[] = [];
    const run = async (options: RunOptions): Promise<RunOutcome> => {
      runs.push(options);
      return runs.length === 2 ? outcome(2, undefined) : passed(0);
    };
    const written: string[] = [];
    const signals = new SignalLadder();
    const session = watchSession({
      base: { files: ['signup'], configPath: undefined },
      cwd: root,
      signals,
      run,
      stdin: undefined,
      write: (text) => written.push(text),
      writeError: (text) => written.push(text),
      pc,
      clear: false,
      watch: fakeWatch(listeners, closed),
    });
    await settle();
    listeners.get(root)!('change', 'e2e.config.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await settle();
    expect(runs[1]).toEqual({ files: ['signup'], configPath: undefined, lastFailed: false, passWithNoTests: true, freshGraph: true });
    expect(written.join('')).toContain(' RERUN  config changed x2');
    // The config did not load: only its directory is watched now, flat.
    expect(closed).toEqual([root, path.join(root, 'tests'), root]);
    listeners.get(root)!('change', 'e2e.config.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(runs).toHaveLength(3);
    signals.escalate(() => undefined);
    await expect(session).resolves.toBe(0);
  });

  it('a config that moves the output swaps the watcher, so the new output is ignored', async () => {
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const closed: string[] = [];
    const runs: RunOptions[] = [];
    const moved = { ...loaded()!, output: 'tests/out' } as RunOutcome['config'];
    const run = async (options: RunOptions): Promise<RunOutcome> => {
      runs.push(options);
      return runs.length === 1 ? passed(0) : outcome(0, moved);
    };
    const signals = new SignalLadder();
    const session = watchSession({
      base: {},
      cwd: root,
      signals,
      run,
      stdin: undefined,
      write: () => undefined,
      writeError: () => undefined,
      pc,
      clear: false,
      watch: fakeWatch(listeners, closed),
    });
    await settle();
    listeners.get(root)!('change', 'e2e.config.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await settle();
    expect(runs).toHaveLength(2);
    expect(closed).toEqual([root, path.join(root, 'tests'), root]);
    mkdirSync(path.join(root, 'tests', 'out'));
    writeFileSync(path.join(root, 'tests', 'out', 'report.json'), '{}');
    listeners.get(path.join(root, 'tests'))!('change', path.join('out', 'report.json'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await settle();
    expect(runs).toHaveLength(2);
    signals.escalate(() => undefined);
    await expect(session).resolves.toBe(0);
  });

  it('keys: a clears the filters, f and u rerun once each, h prints the help, an unmapped key does nothing', async () => {
    const stdin = fakeStdin();
    const runs: RunOptions[] = [];
    const run = async (options: RunOptions): Promise<RunOutcome> => {
      runs.push(options);
      return passed(0);
    };
    const written: string[] = [];
    const signals = new SignalLadder();
    const session = watchSession({
      base: { files: [], configPath: undefined },
      cwd: root,
      signals,
      run,
      stdin,
      write: (text) => written.push(text),
      writeError: (text) => written.push(text),
      pc,
      clear: false,
      watch: fakeWatch(new Map()),
    });
    await settle();
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);

    textMock.mockResolvedValueOnce('login');
    stdin.write('p');
    await settle();
    expect(stdin.setRawMode.mock.calls.map(([raw]) => raw)).toEqual([true, false, true]);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.files).toEqual(['login']);
    expect(written.join('')).toContain(' RERUN  current pattern (files: login) x2');

    stdin.write('f');
    await settle();
    expect(runs[2]).toMatchObject({ files: [], lastFailed: true, passWithNoTests: true });

    stdin.write('u');
    await settle();
    expect(runs[3]).toMatchObject({ files: ['login'], updateSnapshots: true });

    stdin.write('x');
    stdin.write('h');
    await settle();
    expect(runs).toHaveLength(4);
    expect(written.at(-1)).toContain('press r to rerun current pattern tests');

    stdin.write('a');
    await settle();
    expect(runs[4]).toEqual({ files: [], configPath: undefined, lastFailed: false, passWithNoTests: true, freshGraph: true });
    expect(runs[4]!.updateSnapshots).toBeUndefined();
    expect(written.join('')).toContain(' RERUN  all tests x5');

    stdin.write('\x03');
    await expect(session).resolves.toBe(0);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('a cancelled prompt keeps the filters; a change during the prompt runs after it; a signal during the prompt ends the session', async () => {
    const stdin = fakeStdin();
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const runs: RunOptions[] = [];
    const run = async (options: RunOptions): Promise<RunOutcome> => {
      runs.push(options);
      return passed(0);
    };
    const signals = new SignalLadder();
    const session = watchSession({
      base: { files: [], configPath: undefined },
      cwd: root,
      signals,
      run,
      stdin,
      write: () => undefined,
      writeError: () => undefined,
      pc,
      clear: false,
      watch: fakeWatch(listeners),
    });
    await settle();

    let answer: ((value: unknown) => void) | undefined;
    textMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    stdin.write('t');
    await settle();
    // Keys are the prompt's now; a change is kept for after it.
    stdin.write('a');
    listeners.get(path.join(root, 'tests'))!('change', 'a.e2e.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(runs).toHaveLength(1);
    answer!(CANCEL);
    await settle();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ files: ['tests/a.e2e.ts'], grep: undefined });

    // Ctrl-C inside the prompt: the prompt closes on it, and the session ends too.
    textMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    stdin.write('t');
    await settle();
    stdin.write('\x03');
    await settle();
    expect(signals.interruptSignal.aborted).toBe(true);
    answer!(CANCEL);
    await expect(session).resolves.toBe(0);
    expect(runs).toHaveLength(2);
  });

  it('cancels the run a key lands on, keeps the exit code of the last finished run, and quits on q', async () => {
    const stdin = fakeStdin();
    const signals = new SignalLadder();
    const cancels: RunCancel[] = [];
    let release: (() => void) | undefined;
    const run = async (_options: RunOptions, cancel: RunCancel): Promise<RunOutcome> => {
      cancels.push(cancel);
      if (cancels.length === 2) await new Promise<void>((resolve) => (release = resolve));
      return passed(cancels.length === 2 ? 130 : 1);
    };
    const written: string[] = [];
    const session = watchSession({
      base: {},
      cwd: root,
      signals,
      run,
      stdin,
      write: (text) => written.push(text),
      writeError: (text) => written.push(text),
      pc,
      clear: false,
      watch: fakeWatch(new Map()),
    });
    await settle();
    expect(cancels).toHaveLength(1);
    stdin.write('\r');
    await settle();
    expect(cancels).toHaveLength(2);
    expect(written.join('')).toContain(' RERUN  all tests x2');

    stdin.write('q');
    await settle();
    expect(cancels[1]!.interruptSignal.aborted).toBe(true);
    expect(cancels[1]!.forceSignal.aborted).toBe(false);
    stdin.write('q');
    await settle();
    expect(cancels[1]!.forceSignal.aborted).toBe(true);
    release!();
    await settle();
    expect(cancels).toHaveLength(2);
    expect(written.join('')).toContain('run cancelled');
    expect(signals.interruptSignal.aborted).toBe(false);

    stdin.write('q');
    await expect(session).resolves.toBe(1);
  });

  it('ends after a run the interrupt cut short, with its exit code', async () => {
    const signals = new SignalLadder();
    const run = async (): Promise<RunOutcome> => {
      signals.escalate(() => undefined);
      return passed(130);
    };
    const exit = await watchSession({
      base: {},
      cwd: root,
      signals,
      run,
      stdin: undefined,
      write: () => undefined,
      writeError: () => undefined,
      pc,
      clear: false,
      watch: fakeWatch(new Map()),
    });
    expect(exit).toBe(130);
  });

  it('ends with the json reporter from the config, and after the first run when there is nothing to watch and no terminal', async () => {
    const written: string[] = [];
    const json = await watchSession({
      base: {},
      cwd: root,
      signals: new SignalLadder(),
      run: async () => outcome(0, { ...loaded()!, reporters: ['json'] } as RunOutcome['config']),
      stdin: undefined,
      write: (text) => written.push(text),
      writeError: (text) => written.push(text),
      pc,
      clear: false,
      watch: fakeWatch(new Map()),
    });
    expect(json).toBe(2);
    expect(written.join('')).toContain('json reporter');

    rmSync(configPath);
    const nothing = await watchSession({
      base: { configPath: 'missing.config.ts' },
      cwd: root,
      signals: new SignalLadder(),
      run: async () => outcome(1, undefined),
      stdin: undefined,
      write: (text) => written.push(text),
      writeError: (text) => written.push(text),
      pc,
      clear: false,
      watch: fakeWatch(new Map()),
    });
    expect(nothing).toBe(1);
    expect(written.join('')).toContain('nothing to watch');
  });
});
