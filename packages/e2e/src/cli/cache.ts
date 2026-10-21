/**
 * `e2e cache`: what is in the replay cache, and how to get rid of it.
 *
 * The store is a directory of digest-named files, so a committed cache is
 * unreadable without a reader: `ls` prints each entry's provenance — the test,
 * the target, the instruction digest, its age, and how many actions it would
 * replay — `stats` sizes the store, and `clear` empties it.
 *
 * Every command works on files only. A project that configures `cache.store`
 * replaced the filesystem with its own store, and this CLI has no way to
 * enumerate it, so it says so instead of listing an empty directory.
 */

import { readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import picocolors from 'picocolors';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '../cache/store.ts';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig } from '../config/resolve.ts';
import { errorMessage } from '../internal/errors.ts';
import { visibleWidth } from '../report/format.ts';
import { docsLine, examples } from './help.ts';

type CacheCommand = 'ls' | 'clear' | 'stats';

/** The `--cache-dir` help line `e2e run` and every `e2e cache` command share. */
export const CACHE_DIR_DESCRIPTION =
  'replay cache directory, relative to the project root (default: E2E_CACHE_DIR, else cache.dir in the config, else .e2e/cache)';

interface CacheOptions {
  /** Explicit config path; the nearest config file when absent. */
  readonly config?: string;
  /** `--cache-dir`: the store directory, over `E2E_CACHE_DIR` and `cache.dir`. */
  readonly cacheDir?: string;
  readonly cwd?: string;
}

/** One entry as `ls` prints it, or a file that is not a readable entry. */
interface CacheEntrySummary {
  readonly keyHash: string;
  readonly bytes: number;
  readonly createdAt: string;
  readonly actions: number;
  readonly truncated: boolean;
  readonly testId: string | undefined;
  readonly targetId: string | undefined;
  readonly instructionDigest: string | undefined;
}

interface CacheContents {
  readonly directory: string;
  readonly entries: readonly CacheEntrySummary[];
  /** Digest-named files the store could not read: a miss to the runner too. */
  readonly unreadable: readonly { readonly name: string; readonly bytes: number }[];
  /** Files in the directory that are not cache-shaped; never touched. */
  readonly foreign: readonly string[];
}

/** Store file names: the key digest, as `FileCacheStore` writes them. */
const ENTRY_FILE = /^([a-f0-9]{64})\.json$/u;
/** A crashed writer's leftover; a store file for cleanup purposes. */
const TEMPORARY_FILE = /^[a-f0-9]{64}\.json\.[a-f0-9]{16}\.tmp$/u;

/** Digest prefix printed instead of the full 64 hex characters. */
const DIGEST_PREFIX_CHARS = 12;

/**
 * Runs one `e2e cache` command against the configured store directory.
 * Returns the process exit code: 2 for a config or filesystem error, 0
 * otherwise — an empty or absent cache is a fact, not a failure.
 */
async function cache(command: CacheCommand, options: CacheOptions = {}): Promise<number> {
  let directory: string;
  try {
    directory = await resolveCacheDirectory(options);
  } catch (cause) {
    process.stderr.write(`${errorMessage(cause)}\n`);
    return 2;
  }

  try {
    const contents = await readContents(directory);
    switch (command) {
      case 'ls':
        return list(contents);
      case 'stats':
        return stats(contents);
      case 'clear':
        return await clear(contents);
    }
  } catch (cause) {
    process.stderr.write(`replay cache at ${directory} could not be read: ${errorMessage(cause)}\n`);
    return 2;
  }
}

/** Registers `e2e cache` and its `ls`, `clear`, and `stats` subcommands on `program`. */
export function registerCacheCommand(program: Command): void {
  const cacheCommand = program
    .command('cache')
    .summary('inspect, measure, and clear the replay cache')
    .description(
      'Read the replay cache the runs write, under .e2e/cache by default: what a committed cache holds, how much room it takes, and how to empty it. Reads the same config as e2e run, so --cache-dir, E2E_CACHE_DIR, cache.dir, and --config decide which store is meant.',
    )
    .addHelpText(
      'after',
      ['', examples(['e2e cache ls', 'e2e cache stats', 'e2e cache clear']), '', docsLine('/reference/cli#e2e-cache')].join('\n'),
    );

  const cacheSubcommand = (name: CacheCommand, summary: string, description: string): void => {
    cacheCommand
      .command(name)
      .summary(summary)
      .description(description)
      .option('--config <path>', 'config file (default: the nearest e2e.config.ts, .mts, .js, or .mjs)')
      .option('--cache-dir <dir>', CACHE_DIR_DESCRIPTION)
      .action(async (options: { config?: string; cacheDir?: string }) => {
        process.exitCode = await cache(name, options);
      });
  };

  cacheSubcommand(
    'ls',
    'list the cached traces',
    'Print one row per cached trace: the test and target it was recorded for, the digest of its instruction, its age, and how many actions a replay would run.',
  );
  cacheSubcommand('clear', 'delete every cached trace', 'Delete the cache files and the directory itself; files the runner never wrote are left alone.');
  cacheSubcommand('stats', 'print the entry count and size', 'Print the store directory, how many readable entries it holds, and how many bytes they take.');
}

/**
 * The store directory from the project's resolved config, so `--cache-dir`,
 * `E2E_CACHE_DIR`, `cache.dir`, and `--config` mean here what they mean to a run.
 */
async function resolveCacheDirectory(options: CacheOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const discovered = discoverConfig(cwd, options.config);
  if (discovered.configPath === undefined) throw missingConfigError(cwd);
  const raw = await loadConfigModule(discovered.configPath);
  const config = resolveConfig(raw, {
    projectRoot: discovered.projectRoot,
    configPath: discovered.configPath,
    env: process.env,
    cli: options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
  });
  if (config.cache.store !== undefined) {
    throw new Error(
      'cache.store replaces the file store with a custom one; e2e cache reads files only, so inspect that store with its own tools',
    );
  }
  return config.cache.dir;
}

/**
 * Every file in the store directory, classified. Reads go through the store
 * itself, so a file this CLI calls an entry is exactly one a run would
 * replay: an oversized or unparseable file is unreadable here and a miss
 * there. A directory that does not exist is an empty store.
 */
async function readContents(directory: string): Promise<CacheContents> {
  const store = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
  const entries: CacheEntrySummary[] = [];
  const unreadable: { name: string; bytes: number }[] = [];
  const foreign: string[] = [];

  let names: string[];
  try {
    names = await readdir(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { directory, entries, unreadable, foreign };
    }
    throw cause;
  }

  for (const name of names.toSorted()) {
    const keyHash = ENTRY_FILE.exec(name)?.[1];
    if (keyHash === undefined) {
      if (!TEMPORARY_FILE.test(name)) foreign.push(name);
      continue;
    }
    const read = await store.read(keyHash);
    if (read.status !== 'hit') {
      unreadable.push({ name, bytes: read.status === 'invalid' ? (read.bytes ?? 0) : 0 });
      continue;
    }
    const trace = read.entry.payload;
    entries.push({
      keyHash,
      bytes: read.bytes,
      createdAt: read.entry.createdAt,
      actions: trace.actions.length,
      truncated: trace.truncated === true,
      testId: trace.recordedFor?.testId,
      targetId: trace.recordedFor?.targetId,
      instructionDigest: trace.recordedFor?.instructionDigest,
    });
  }
  return { directory, entries, unreadable, foreign };
}

/**
 * Prints one row per entry, newest last within a test, so a reviewer reads a
 * committed cache test by test. Provenance an entry does not carry — one
 * recorded before entries described themselves — prints as `-`.
 */
function list(contents: CacheContents): number {
  if (contents.entries.length === 0) {
    process.stdout.write(`no replay cache entries in ${contents.directory}\n`);
    warnAboutSkipped(contents);
    return 0;
  }
  const now = Date.now();
  const rows = contents.entries
    .toSorted(
      (left, right) =>
        (left.testId ?? '').localeCompare(right.testId ?? '') ||
        (left.targetId ?? '').localeCompare(right.targetId ?? '') ||
        left.createdAt.localeCompare(right.createdAt),
    )
    .map((entry) => [
      entry.testId ?? '-',
      entry.targetId ?? '-',
      entry.instructionDigest?.slice(0, DIGEST_PREFIX_CHARS) ?? '-',
      formatAge(entry.createdAt, now),
      `${entry.actions}${entry.truncated ? ' (truncated)' : ''}`,
    ]);
  const header = ['TEST', 'TARGET', 'INSTRUCTION', 'AGE', 'ACTIONS'];
  const widths = header.map((title, column) =>
    Math.max(visibleWidth(title), ...rows.map((row) => visibleWidth(row[column]!))),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell + ' '.repeat(widths[column]! - visibleWidth(cell))))
      .join('  ')
      .trimEnd();
  process.stdout.write(`${picocolors.bold(line(header))}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
  warnAboutSkipped(contents);
  return 0;
}

/** Prints the store's size: where it is, how many entries, how many bytes. */
function stats(contents: CacheContents): number {
  const bytes = contents.entries.reduce((total, entry) => total + entry.bytes, 0);
  const rows: [string, string][] = [
    ['directory', contents.directory],
    ['entries', String(contents.entries.length)],
    ['size', formatBytes(bytes)],
  ];
  if (contents.unreadable.length > 0) rows.push(['unreadable', String(contents.unreadable.length)]);
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    process.stdout.write(`${label.padEnd(width)}  ${value}\n`);
  }
  warnAboutSkipped(contents);
  return 0;
}

/**
 * Deletes the store's own files and the directory when nothing else is left
 * in it. Files the store never wrote stay: `cache.dir` can point anywhere,
 * and a mistyped one must not take a project's files with it.
 */
async function clear(contents: CacheContents): Promise<number> {
  const removable = [
    ...contents.entries.map((entry) => `${entry.keyHash}.json`),
    ...contents.unreadable.map((file) => file.name),
  ];
  for (const name of removable) {
    await rm(path.join(contents.directory, name), { force: true });
  }
  // Leftover temporaries are neither entries nor foreign files; they go too.
  const temporaries = await removeTemporaries(contents.directory);
  const removed = removable.length + temporaries;
  if (contents.foreign.length === 0) await rmdir(contents.directory).catch(() => undefined);
  process.stdout.write(
    removed === 0
      ? `no replay cache entries to clear in ${contents.directory}\n`
      : `cleared ${removed} file(s) from ${contents.directory}\n`,
  );
  warnAboutSkipped(contents);
  return 0;
}

async function removeTemporaries(directory: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!TEMPORARY_FILE.test(name)) continue;
    await rm(path.join(directory, name), { force: true });
    removed += 1;
  }
  return removed;
}

/** Names what was left alone, so a surprising count has an explanation. */
function warnAboutSkipped(contents: CacheContents): void {
  if (contents.unreadable.length > 0) {
    process.stderr.write(
      `${contents.unreadable.length} file(s) in ${contents.directory} are not readable trace-1 entries; a run treats each as a miss\n`,
    );
  }
  if (contents.foreign.length > 0) {
    process.stderr.write(
      `${contents.foreign.length} file(s) in ${contents.directory} are not cache files and were left alone: ${contents.foreign.join(', ')}\n`,
    );
  }
}

/** Coarse age of one entry: the unit a reviewer cares about, nothing finer. */
function formatAge(createdAt: string, now: number): string {
  const ms = now - Date.parse(createdAt);
  if (!Number.isFinite(ms)) return '-';
  // A future timestamp is a clock difference between two machines, not an age.
  if (ms < 60_000) return ms < 0 ? '0m' : '<1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
