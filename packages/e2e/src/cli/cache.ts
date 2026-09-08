/**
 * `e2e cache`: what is in the trace cache, and how to get rid of it.
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
import picocolors from 'picocolors';
import { FileTraceCacheStore, MAX_CACHE_WIRE_BYTES } from '../cache/store.ts';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig } from '../config/resolve.ts';
import { errorMessage } from '../internal/errors.ts';

export type CacheCommand = 'ls' | 'clear' | 'stats';

export interface CacheOptions {
  /** Explicit config path; the nearest `e2e.config.ts` when absent. */
  readonly config?: string;
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

/** Store file names: the key digest, as `FileTraceCacheStore` writes them. */
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
export async function cache(command: CacheCommand, options: CacheOptions = {}): Promise<number> {
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
    process.stderr.write(`trace cache at ${directory} could not be read: ${errorMessage(cause)}\n`);
    return 2;
  }
}

/**
 * The store directory from the project's resolved config, so `cache.dir` and
 * `--config` mean here what they mean to a run.
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
  const store = new FileTraceCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
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
    process.stdout.write(`no trace cache entries in ${contents.directory}\n`);
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
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
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
      ? `no trace cache entries to clear in ${contents.directory}\n`
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
