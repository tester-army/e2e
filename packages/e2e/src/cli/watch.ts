/**
 * `e2e run --watch`: the run, then a loop that runs again when a test file
 * or the config changes, or when a key asks for it, the way `vitest` does.
 * Every iteration is one complete `run()`, so each writes its report and
 * tears its engines and app down; what the loop owns is the file watcher,
 * the keyboard, and the filters the keys set over the command line's.
 */

import { existsSync, readdirSync, statSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { Writable } from 'node:stream';
import * as clack from '@clack/prompts';
import picocolors from 'picocolors';
import { discoverConfig } from '../config/load.ts';
import { compileGlob, compileGlobList, GLOB_SYNTAX, literalPrefix, matchesGlob, type CompiledGlobList } from '../internal/globs.ts';
import type { RunOptions, RunOutcome } from '../run/runner.ts';
import type { SignalLadder } from './signals.ts';

/**
 * What asks for a run: the terminal names it in the banner above the run.
 * `files` are saved test files; `source` are other saved project files
 * under the watched directories (helpers, fixtures), which rerun the
 * current selection since nothing says which tests import them.
 */
export type WatchTrigger =
  | { readonly kind: 'start' }
  | { readonly kind: 'files'; readonly files: readonly string[] }
  | { readonly kind: 'source'; readonly files: readonly string[] }
  | { readonly kind: 'config' }
  | { readonly kind: 'key'; readonly key: 'a' | 'r' | 'f' | 'u' };

/** The filters the keys set, over the command line's: a positional (`p`) and a title pattern (`t`). */
export interface WatchFilters {
  readonly file: string | undefined;
  readonly title: RegExp | undefined;
}

/** No `p` or `t` filter set: the command line's selection alone. */
export const NO_FILTERS: WatchFilters = { file: undefined, title: undefined };

/**
 * The options of the next run: the command line's, with the trigger's
 * selection over them. `--last-failed` and the test filters are the first
 * run's alone, so a save or a key never calls a filter's model; `f` asks for
 * `--last-failed` again, against the report the run before wrote, and a run with
 * nothing failed is then an empty pass, not `NO_TESTS`. A changed file
 * runs whole, inside every other filter of the command line, in place of
 * the positionals; the keys and a config change keep the positionals, or
 * the `p` filter over them, except `a`, which runs the command line's
 * selection whole, as `a` and enter do in vitest, and `f`, which runs what
 * the last report has failing wherever it is, since a saved file ran in
 * place of the positionals. A rerun that selects nothing passes empty: the
 * session goes on waiting, as vitest's does.
 * Each rerun reads the project's files afresh (`freshGraph`), so a saved
 * helper is what the next run collects.
 */
export function planRun(base: RunOptions, filters: WatchFilters, trigger: WatchTrigger): RunOptions {
  if (trigger.kind === 'start') return { ...base, freshGraph: true };
  const filtered: RunOptions = {
    ...base,
    freshGraph: true,
    lastFailed: false,
    changedSince: undefined,
    passWithNoTests: true,
    files: filters.file === undefined ? base.files : [filters.file],
    grep: filters.title === undefined ? base.grep : [filters.title],
  };
  switch (trigger.kind) {
    case 'files':
      return { ...filtered, files: trigger.files };
    case 'source':
    case 'config':
      return filtered;
    case 'key':
      switch (trigger.key) {
        case 'a':
          return { ...filtered, files: base.files, grep: base.grep };
        case 'r':
          return filtered;
        case 'f':
          return { ...filtered, files: [], lastFailed: true };
        case 'u':
          return { ...filtered, updateSnapshots: true };
      }
  }
}

/** What the watcher reads from the config: where the project is, which file configures it, which files are tests. */
export interface WatchScope {
  readonly projectRoot: string;
  readonly configPath: string | undefined;
  /** The config's `tests` globs; none when the config did not load. */
  readonly tests: readonly string[];
  /** Directories the run itself writes, by absolute path: the output and the cache. A change there is the run's own, not a save. */
  readonly written: readonly string[];
}

/**
 * The scope a run leaves behind: its config, or before the first run and
 * for a config that did not load, the config file it would be, alone.
 */
function scopeOf(config: RunOutcome['config'], cwd: string, configPath: string | undefined): WatchScope {
  if (config !== undefined) {
    const { projectRoot, configPath: loadedPath, tests, output, cache } = config;
    return { projectRoot, configPath: loadedPath, tests, written: [path.resolve(projectRoot, output), cache.dir] };
  }
  try {
    const discovered = discoverConfig(cwd, configPath);
    return { projectRoot: discovered.projectRoot, configPath: discovered.configPath, tests: [], written: [] };
  } catch {
    return { projectRoot: cwd, configPath: undefined, tests: [], written: [] };
  }
}

/** One file change the watcher reports, by project-relative path: a test file, another source file, or the config. */
export type WatchChange =
  | { readonly kind: 'test'; readonly file: string }
  | { readonly kind: 'source'; readonly file: string }
  | { readonly kind: 'config' };

/** The extensions of the files a test could import: a save to one reruns the selection. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.json']);

/** A directory the watcher never enters, where discovery never does either: installed packages, and dot directories such as the output. */
function skippedDirectory(name: string): boolean {
  return name === 'node_modules' || name.startsWith('.');
}

/** Whether `absolutePath` is `dir` or under it. */
function isInside(dir: string, absolutePath: string): boolean {
  const relative = path.relative(dir, absolutePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * What the scope makes of a changed path: a test file, a source file a test
 * could import, the config, or nothing it watches. Paths under
 * `node_modules` or a dot directory are nothing, as discovery skips them;
 * so is what the run writes (`report.json`, a recording), or the run would
 * trigger itself.
 */
export function classifyChange(scope: WatchScope, globs: CompiledGlobList, absolutePath: string): WatchChange | undefined {
  if (scope.configPath !== undefined && path.resolve(absolutePath) === scope.configPath) return { kind: 'config' };
  if (scope.written.some((dir) => isInside(dir, absolutePath))) return undefined;
  const relative = path.relative(scope.projectRoot, absolutePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const segments = relative.split(path.sep);
  if (segments.slice(0, -1).some(skippedDirectory)) return undefined;
  const file = segments.join('/');
  if (globs.include.some((glob) => matchesGlob(glob, file))) {
    return globs.exclude.some((glob) => matchesGlob(glob, file)) ? undefined : { kind: 'test', file };
  }
  return SOURCE_EXTENSIONS.has(path.extname(file)) ? { kind: 'source', file } : undefined;
}

/** A directory to watch: recursively where a glob reaches below it, flat where only the config file is there. */
export interface WatchRoot {
  readonly dir: string;
  readonly recursive: boolean;
}

/**
 * The directories the scope's files live under: the literal prefix of each
 * `tests` glob (`tests/**\/*.e2e.ts` watches `tests/`), climbed to the
 * nearest directory that exists so a prefix created later is seen too, and
 * the config's own directory. A glob that starts at the project root
 * (`**\/*.e2e.ts`) watches the root flat and each of its directories, not
 * `node_modules` or a dot directory: Linux registers a watch per file
 * under a recursive root, and installed packages would exhaust them. A
 * root under a recursive root is dropped.
 */
export function watchRoots(scope: WatchScope, globs: CompiledGlobList): WatchRoot[] {
  const roots: WatchRoot[] = [];
  for (const glob of globs.include) {
    let dir = path.join(scope.projectRoot, ...literalPrefix(glob));
    if (literalPrefix(glob).length === glob.segments.length) dir = path.dirname(dir);
    while (!existsSync(dir) && dir !== scope.projectRoot && dir.startsWith(scope.projectRoot)) dir = path.dirname(dir);
    if (dir === scope.projectRoot) {
      roots.push({ dir, recursive: false }, ...childDirectories(dir, scope.written).map((child) => ({ dir: child, recursive: true })));
    } else {
      roots.push({ dir, recursive: true });
    }
  }
  if (scope.configPath !== undefined) roots.push({ dir: path.dirname(scope.configPath), recursive: false });
  return roots.filter(
    (root, index) =>
      roots.findIndex((other) => other.dir === root.dir && other.recursive === root.recursive) === index &&
      !roots.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.recursive &&
          (other.dir === root.dir ? otherIndex < index || !root.recursive : root.dir.startsWith(`${other.dir}${path.sep}`)),
      ),
  );
}

/** The directories under `dir` worth watching, by absolute path: not the skipped names, not where the run writes. */
function childDirectories(dir: string, written: readonly string[]): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !skippedDirectory(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .filter((child) => !written.some((out) => isInside(out, child)))
      .toSorted();
  } catch {
    return [];
  }
}

/** A watcher over one root: closable, and an emitter of `error` when the platform's watch fails under it. */
export interface RootWatcher {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** `fs.watch` as the watcher uses it, so a test can stand in for the file system. */
export type WatchFn = (
  dir: string,
  options: { readonly recursive: boolean },
  listener: (event: string, filename: string | Buffer | null) => void,
) => RootWatcher;

/** A burst of changes, debounced: the test files and the source files touched, and whether the config was. */
export interface WatchChanges {
  readonly files: readonly string[];
  readonly sources: readonly string[];
  readonly config: boolean;
}

/** How long after the last change the watcher reports: an editor's save is several events. */
export const DEBOUNCE_MS = 100;

/**
 * Watches the scope's roots and reports each burst of changes once,
 * debounced. Changes that are nothing it watches are dropped where they
 * happen. A directory created under a flat root starts the roots over, so
 * a `tests/` made after the session began is watched too. A root whose
 * watch fails, at once or later (Linux out of inotify watches, a directory
 * gone), is dropped and named to `onLost`; the keys still rerun.
 */
export class ChangeWatcher {
  private readonly watchers: RootWatcher[] = [];
  private readonly files = new Set<string>();
  private readonly sources = new Set<string>();
  private config = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly globs: CompiledGlobList;

  constructor(
    private readonly scope: WatchScope,
    private readonly onChanges: (changes: WatchChanges) => void,
    private readonly onLost: (dir: string, error: Error) => void,
    private readonly watch: WatchFn = fsWatch,
  ) {
    this.globs = compileGlobList(scope.tests);
  }

  /** Starts watching; answers the roots that could be watched. */
  start(): WatchRoot[] {
    const watched: WatchRoot[] = [];
    for (const root of watchRoots(this.scope, this.globs)) {
      let watcher: RootWatcher;
      try {
        watcher = this.watch(root.dir, { recursive: root.recursive }, (event, filename) => this.onEvent(root, event, filename));
      } catch (cause) {
        this.onLost(root.dir, cause instanceof Error ? cause : new Error(String(cause)));
        continue;
      }
      watcher.on('error', (error) => {
        watcher.close();
        const index = this.watchers.indexOf(watcher);
        if (index !== -1) this.watchers.splice(index, 1);
        this.onLost(root.dir, error);
      });
      this.watchers.push(watcher);
      watched.push(root);
    }
    return watched;
  }

  /** Stops watching; a burst still pending is dropped. */
  close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopWatching();
  }

  private stopWatching(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }

  private onEvent(root: WatchRoot, event: string, filename: string | Buffer | null): void {
    if (filename === null) return;
    const absolutePath = path.join(root.dir, filename.toString());
    if (!root.recursive && event === 'rename' && isDirectory(absolutePath) && !skippedDirectory(path.basename(absolutePath))) {
      this.stopWatching();
      this.start();
      return;
    }
    const change = classifyChange(this.scope, this.globs, absolutePath);
    if (change !== undefined) this.record(change);
  }

  private record(change: WatchChange): void {
    if (change.kind === 'config') this.config = true;
    else if (change.kind === 'test') this.files.add(change.file);
    else this.sources.add(change.file);
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const changes: WatchChanges = { files: [...this.files].toSorted(), sources: [...this.sources].toSorted(), config: this.config };
      this.files.clear();
      this.sources.clear();
      this.config = false;
      this.onChanges(changes);
    }, DEBOUNCE_MS);
  }
}

/** Whether `absolutePath` is a directory now; a path gone again is not. */
function isDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What a burst of changes asks for: the config over everything, else a
 * saved source file over the test files, else the test files that still
 * exist, else nothing.
 */
export function triggerOf(scope: WatchScope, changes: WatchChanges): WatchTrigger | undefined {
  if (changes.config) return { kind: 'config' };
  const existing = (files: readonly string[]): string[] => files.filter((file) => existsSync(path.join(scope.projectRoot, file)));
  const sources = existing(changes.sources);
  if (sources.length > 0) return { kind: 'source', files: sources };
  const files = existing(changes.files);
  return files.length === 0 ? undefined : { kind: 'files', files };
}

/** How triggers rank when two wait for one run: the wider one runs. */
const TRIGGER_RANK: Record<WatchTrigger['kind'], number> = { start: 0, files: 1, source: 2, key: 3, config: 4 };

/** Two triggers that arrived before a run could take them, folded into one: the wider, or the union of two of a kind. */
export function mergeTriggers(first: WatchTrigger, second: WatchTrigger): WatchTrigger {
  if ((first.kind === 'files' && second.kind === 'files') || (first.kind === 'source' && second.kind === 'source')) {
    return { kind: first.kind, files: [...new Set([...first.files, ...second.files])].toSorted() };
  }
  return TRIGGER_RANK[second.kind] > TRIGGER_RANK[first.kind] ? second : first;
}

/** A key the terminal delivers, as `readline` names it. */
export interface Keypress {
  readonly name: string | undefined;
  readonly ctrl: boolean;
  readonly sequence?: string | undefined;
}

/** A key the session acts on: vitest's, plus what the terminal cannot deliver as a signal in raw mode. */
export type WatchKey = 'a' | 'r' | 'f' | 'u' | 'p' | 't' | 'h' | 'q' | 'cancel' | 'interrupt' | 'suspend';

/**
 * The watch key a keypress means, or none. Enter is `a` and escape is
 * Ctrl-C, as in vitest; space and `c` only cancel a run. Ctrl-C, Ctrl-D
 * and Ctrl-Z arrive as keypresses in raw mode, not as signals.
 */
export function keyOf(press: Keypress): WatchKey | undefined {
  if (press.ctrl) {
    if (press.name === 'c' || press.name === 'd') return 'interrupt';
    return press.name === 'z' ? 'suspend' : undefined;
  }
  switch (press.name) {
    case 'return':
      return 'a';
    case 'escape':
      return 'interrupt';
    case 'space':
    case 'c':
      return 'cancel';
    case 'a':
    case 'r':
    case 'f':
    case 'u':
    case 'p':
    case 't':
    case 'h':
    case 'q':
      return press.name;
    default:
      return undefined;
  }
}

const HELP_LINES: readonly (readonly [key: string, meaning: string])[] = [
  ['a, enter', 'rerun all tests'],
  ['r', 'rerun current pattern tests'],
  ['f', 'rerun only failed tests'],
  ['u', 'update snapshot'],
  ['p', 'filter by a filename'],
  ['t', 'filter by a test name regex pattern'],
  ['q', 'quit'],
];

/** The lines under a finished run: what to press. */
function helpText(pc: ReturnType<typeof picocolors.createColors>, full: boolean): string {
  const press = (key: string, meaning: string): string => `${pc.dim('press')} ${pc.bold(key)} ${pc.dim(`to ${meaning}`)}`;
  if (!full) return `${press('h', 'show help')}${pc.dim(',')} ${press('q', 'quit')}\n`;
  return HELP_LINES.map(([key, meaning]) => `  ${press(key, meaning)}`).join('\n') + '\n';
}

/** The banner above a rerun: why it runs, and how many runs the session has made. */
export function bannerText(pc: ReturnType<typeof picocolors.createColors>, trigger: WatchTrigger, filters: WatchFilters, count: number): string {
  const why =
    trigger.kind === 'files' || trigger.kind === 'source'
      ? trigger.files.join(', ')
      : trigger.kind === 'config'
        ? 'config changed'
        : trigger.kind === 'key'
          ? { a: 'all tests', r: 'current pattern', f: 'failed tests', u: 'update snapshot' }[trigger.key]
          : 'start';
  const applied = [
    ...(filters.file === undefined ? [] : [`files: ${filters.file}`]),
    ...(filters.title === undefined ? [] : [`title: ${filters.title.source}`]),
  ];
  const filter = applied.length === 0 ? '' : pc.dim(` (${applied.join(', ')})`);
  return `${pc.inverse(pc.bold(' RERUN '))} ${why}${filter} ${pc.dim(`x${count}`)}\n\n`;
}

/** ANSI: clear the screen and the scrollback, cursor home; a rerun starts on a clean terminal as vitest's does. */
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/** One run's cancellation, as a key asks for it: the same two rungs the process signals have. */
export interface RunCancel {
  readonly interruptSignal: AbortSignal;
  readonly forceSignal: AbortSignal;
}

/** What `watchSession` needs from the command: the run, the terminal, and the signals. */
export interface WatchSessionOptions {
  /** The run options the command line parsed, without the signals and the process output; the session adds those. */
  readonly base: RunOptions;
  readonly cwd: string;
  readonly signals: SignalLadder;
  /**
   * Executes one run: the real runner, with the session's signals and the
   * process's output, and the telemetry record. `cancel` is this run's own
   * ladder, for the keys: the first interrupts it, the next forces it.
   */
  readonly run: (options: RunOptions, cancel: RunCancel) => Promise<RunOutcome>;
  /** The keyboard, when stdin is a terminal; without it only file changes rerun. */
  readonly stdin: NodeJS.ReadStream | undefined;
  /** Writes the session's own lines to the terminal. */
  readonly write: (text: string) => void;
  /** Writes an error to stderr, past a reporter that owns stdout. */
  readonly writeError: (text: string) => void;
  readonly pc: ReturnType<typeof picocolors.createColors>;
  /** Clears the terminal before a rerun; off when stdout is not a terminal. */
  readonly clear: boolean;
  readonly watch?: WatchFn | undefined;
}

/**
 * The watch loop: runs, then waits for a change or a key, and runs again,
 * until a quit or a signal. Answers the exit code of the last run that
 * finished. A change that lands during a run is kept and runs next; a key
 * during a run cancels it, as in vitest, and the loop waits again, while
 * Ctrl-C interrupts it as a signal would and ends the session. A config
 * with the json reporter ends it too: that reporter's stdout is one
 * document, as `--reporter json` is refused before it starts.
 */
export async function watchSession(options: WatchSessionOptions): Promise<number> {
  const { pc, signals } = options;
  let filters = NO_FILTERS;
  let trigger: WatchTrigger = { kind: 'start' };
  /** What arrived while a run or a prompt had the terminal: the next run's trigger. */
  let pending: WatchTrigger | undefined;
  let count = 0;
  let scope: WatchScope | undefined;
  let watcher: ChangeWatcher | undefined;
  let running: { readonly interrupt: AbortController; readonly force: AbortController } | undefined;
  let wake: ((value: Wake) => void) | undefined;
  let exitCode = 0;

  const arrive = (next: WatchTrigger): void => {
    if (wake === undefined) pending = pending === undefined ? next : mergeTriggers(pending, next);
    else wake(next);
  };
  const keyboard = options.stdin === undefined ? undefined : new Keyboard(options.stdin);
  keyboard?.listen((key) => {
    if (key === 'interrupt') {
      signals.escalate();
      return;
    }
    if (key === 'suspend') {
      keyboard.suspend();
      return;
    }
    if (running !== undefined) {
      if (running.interrupt.signal.aborted) running.force.abort();
      else running.interrupt.abort();
      return;
    }
    switch (key) {
      case 'q':
        wake?.('quit');
        return;
      case 'h':
        options.write(helpText(pc, true));
        return;
      case 'p':
      case 't':
        wake?.(key);
        return;
      case 'a':
        filters = NO_FILTERS;
        arrive({ kind: 'key', key });
        return;
      case 'r':
      case 'f':
      case 'u':
        arrive({ kind: 'key', key });
    }
  });
  const quit = (): void => wake?.('quit');
  signals.interruptSignal.addEventListener('abort', quit, { once: true });
  const waiting = (): void =>
    options.write(`\n${pc.dim('Waiting for file changes...')}\n${keyboard === undefined ? '' : `  ${helpText(pc, false)}`}`);
  const terminal = terminalStream(options.write);
  let watched: WatchRoot[] = [];
  /** Watches `next` in place of the scope watched so far, when it differs; answers whether it did. */
  const rescope = (next: WatchScope): boolean => {
    if (scope !== undefined && sameScope(scope, next)) return false;
    watcher?.close();
    scope = next;
    watcher = new ChangeWatcher(
      next,
      (changes) => {
        const change = triggerOf(next, changes);
        if (change !== undefined) arrive(change);
      },
      (dir, error) => options.write(`${pc.yellow('stopped watching')} ${dir}: ${error.message}; the keys still rerun\n`),
      options.watch,
    );
    watched = watcher.start();
    return true;
  };

  try {
    // The config file is watched from the start; its test directories once it has loaded.
    rescope(scopeOf(undefined, options.cwd, options.base.configPath));
    for (;;) {
      const cancel = { interrupt: new AbortController(), force: new AbortController() };
      running = cancel;
      count += 1;
      if (trigger.kind !== 'start') {
        options.write(`${options.clear ? CLEAR_SCREEN : '\n'}${bannerText(pc, trigger, filters, count)}`);
      }
      const outcome = await options.run(planRun(options.base, filters, trigger), {
        interruptSignal: cancel.interrupt.signal,
        forceSignal: cancel.force.signal,
      });
      running = undefined;
      if (signals.interruptSignal.aborted) {
        exitCode = outcome.exitCode;
        break;
      }
      if (cancel.interrupt.signal.aborted) options.write(`\n${pc.yellow('run cancelled')}\n`);
      else exitCode = outcome.exitCode;
      if (outcome.config?.reporters.includes('json') === true) {
        options.writeError(`${pc.red('error')}: --watch cannot run with the json reporter the config sets: it writes one document to stdout\n`);
        return 2;
      }

      const changed = rescope(scopeOf(outcome.config, options.cwd, options.base.configPath));
      if ((changed || count === 1) && watched.length === 0) {
        if (keyboard === undefined) {
          options.write(`${pc.yellow('nothing to watch')}: no test directory or config file to watch, and no terminal for the keys\n`);
          return exitCode;
        }
        options.write(`${pc.yellow('nothing to watch')}: no test directory or config file to watch; the keys still rerun\n`);
      }

      let woken: WatchTrigger | 'quit' | undefined;
      while (woken === undefined) {
        // A signal that landed while a prompt had the terminal, or between runs, ends the session too.
        if (signals.interruptSignal.aborted) {
          woken = 'quit';
          break;
        }
        if (pending !== undefined) {
          woken = pending;
          pending = undefined;
          break;
        }
        waiting();
        const value = await new Promise<Wake>((resolve) => {
          wake = (woke) => {
            wake = undefined;
            resolve(woke);
          };
        });
        if (value !== 'p' && value !== 't') {
          woken = value;
          break;
        }
        // The prompt owns the terminal: keys wait, and so does a change, in `pending`.
        keyboard?.pause();
        const answer = await (value === 'p' ? promptFile(filters, terminal) : promptTitle(filters, terminal));
        keyboard?.resume();
        if (answer !== undefined && !signals.interruptSignal.aborted) {
          filters = answer;
          woken = { kind: 'key', key: 'r' };
        }
      }
      if (woken === 'quit') break;
      trigger = woken;
    }
  } finally {
    signals.interruptSignal.removeEventListener('abort', quit);
    watcher?.close();
    keyboard?.close();
  }
  return exitCode;
}

/** What ends an idle wait: a trigger, a prompt to open, or the end of the session. */
type Wake = WatchTrigger | 'quit' | 'p' | 't';

/** Whether two runs left the same thing to watch, so the watcher can stay. */
function sameScope(a: WatchScope, b: WatchScope): boolean {
  const same = (x: readonly string[], y: readonly string[]): boolean => x.length === y.length && x.every((item, i) => item === y[i]);
  return a.projectRoot === b.projectRoot && a.configPath === b.configPath && same(a.tests, b.tests) && same(a.written, b.written);
}

/** `p`: the positional the next runs select with; empty clears it. Answers nothing when cancelled or an invalid glob. */
async function promptFile(filters: WatchFilters, output: Writable): Promise<WatchFilters | undefined> {
  const answer = await clack.text({
    output,
    message: 'Filter by a file name, path, or glob (empty clears the filter)',
    placeholder: 'signup',
    defaultValue: '',
    initialValue: filters.file ?? '',
    validate: (value) => invalidGlob(value ?? ''),
  });
  if (clack.isCancel(answer)) return undefined;
  const value = answer.trim();
  return { ...filters, file: value === '' ? undefined : value };
}

/** `t`: the title pattern the next runs select with; empty clears it. Answers nothing when cancelled or invalid. */
async function promptTitle(filters: WatchFilters, output: Writable): Promise<WatchFilters | undefined> {
  const answer = await clack.text({
    output,
    message: 'Filter by a test name regex pattern (empty clears the filter)',
    placeholder: 'checkout',
    defaultValue: '',
    initialValue: filters.title?.source ?? '',
    validate: (value) => invalidPattern(value ?? ''),
  });
  if (clack.isCancel(answer)) return undefined;
  const value = answer.trim();
  return { ...filters, title: value === '' ? undefined : new RegExp(value) };
}

/**
 * The terminal as a stream, for the prompts: `write` reaches stdout past
 * the run's redaction, which holds a line's tail for a value a later write
 * could complete, so a prompt's last escape sequence would otherwise print
 * under the next run as runner output.
 */
function terminalStream(write: (text: string) => void): Writable {
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      write(chunk.toString());
      callback();
    },
  });
  Object.defineProperty(stream, 'columns', { get: () => process.stdout.columns });
  return stream;
}

/** Why `value`, when it is a glob, does not compile, or nothing when it does or is a plain name. */
function invalidGlob(value: string): string | undefined {
  if (!GLOB_SYNTAX.test(value)) return undefined;
  try {
    compileGlob(value);
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** Why `source` is not a regular expression, or nothing when it is. */
function invalidPattern(source: string): string | undefined {
  try {
    RegExp(source);
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** Raw-mode stdin delivering watch keys, pausable while a prompt owns the terminal. */
class Keyboard {
  private handler: ((key: WatchKey) => void) | undefined;
  private readonly onKeypress = (_chunk: unknown, press: Keypress | undefined): void => {
    if (press === undefined || this.handler === undefined) return;
    const key = keyOf(press);
    if (key !== undefined) this.handler(key);
  };
  /** While a prompt has the keys, Ctrl-C still ends the session: the prompt only closes on it. */
  private readonly onInterruptOnly = (_chunk: unknown, press: Keypress | undefined): void => {
    if (press !== undefined && press.ctrl && keyOf(press) === 'interrupt') this.handler?.('interrupt');
  };

  constructor(private readonly stdin: NodeJS.ReadStream) {
    emitKeypressEvents(stdin);
  }

  /** Starts delivering keys to `handler`, in raw mode. */
  listen(handler: (key: WatchKey) => void): void {
    this.handler = handler;
    this.resume();
  }

  /** Takes the terminal back after a prompt: raw mode on, keys delivered again. */
  resume(): void {
    this.stdin.off('keypress', this.onInterruptOnly);
    this.stdin.setRawMode?.(true);
    this.stdin.on('keypress', this.onKeypress);
    this.stdin.resume();
  }

  /** Hands the terminal to a prompt: raw mode off, no key but Ctrl-C delivered. */
  pause(): void {
    this.stdin.off('keypress', this.onKeypress);
    this.stdin.on('keypress', this.onInterruptOnly);
    this.stdin.setRawMode?.(false);
  }

  /**
   * Ctrl-Z: stops the process as the terminal would outside raw mode, with
   * the terminal restored first. The stop goes to the whole process group,
   * the job the shell waits on: a `| tee` or a package manager's wrapper
   * stops with it, and one `fg` resumes them all. Timers do not run while
   * a process is stopped: the resume fires on the continue, or at once
   * under a shell without job control, where the stop is ignored.
   */
  suspend(): void {
    if (process.platform === 'win32') return;
    this.pause();
    setTimeout(() => this.resume(), 0);
    process.kill(0, 'SIGTSTP');
  }

  /** Stops for good: raw mode off, stdin paused so it no longer holds the process open. */
  close(): void {
    this.stdin.off('keypress', this.onKeypress);
    this.stdin.off('keypress', this.onInterruptOnly);
    this.stdin.setRawMode?.(false);
    this.stdin.pause();
  }
}
