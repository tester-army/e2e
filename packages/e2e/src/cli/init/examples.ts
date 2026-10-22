/**
 * The `e2e init --example` step: copies one of the repository's `examples/`
 * apps into the project directory. The examples are not in the npm package;
 * they come from the GitHub tarball of the tag this CLI was released under,
 * or from `main` when that tag does not exist (a canary or a source build).
 */

import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { USER_AGENT } from '../../internal/client-identity.ts';
import { packageVersion } from '../../internal/package-version.ts';
import { readPackage, serializePackage } from './package.ts';
import { dependencyRange, recordedSiblingRange } from './versions.ts';

export interface ExamplePreset {
  /** The folder name under `examples/`, which is also the flag value. */
  readonly id: string;
  /** Where the e2e project sits inside the example: the root for JS apps, `e2e` beside a native project. */
  readonly project: '.' | 'e2e';
  /** The package script that runs the tests, named in the closing `Next:` line. */
  readonly script: string;
  /** Whether the app has to be built and installed on a device before the tests run. */
  readonly build: boolean;
}

/** Every standalone app under `examples/`. `with-limrun` is left out: it reuses the SwiftUI and Compose apps. */
export const EXAMPLES: readonly ExamplePreset[] = [
  { id: 'with-vite', project: '.', script: 'test:e2e', build: false },
  { id: 'with-next', project: '.', script: 'test:e2e', build: false },
  { id: 'with-astro', project: '.', script: 'test:e2e', build: false },
  // The web target starts the dev server itself; the device targets need a build first.
  { id: 'with-expo', project: '.', script: 'test:e2e:web', build: false },
  { id: 'with-swiftui', project: 'e2e', script: 'test:e2e', build: true },
  { id: 'with-compose', project: 'e2e', script: 'test:e2e', build: true },
  { id: 'with-kotlin-multiplatform', project: 'e2e', script: 'test:e2e:android', build: true },
  { id: 'with-flutter', project: 'e2e', script: 'test:e2e:android', build: true },
  { id: 'with-maui', project: 'e2e', script: 'test:e2e:android', build: true },
];

/** The preset a flag value names: the folder name, or the same without `with-`. */
export function findExample(name: string): ExamplePreset | undefined {
  const id = name.startsWith('with-') ? name : `with-${name}`;
  return EXAMPLES.find((example) => example.id === id);
}

const REPOSITORY = 'tester-army/e2e';
/** Entries a directory may hold and still count as empty for an example. */
const IGNORED_ENTRIES = new Set(['.git', '.DS_Store', 'Thumbs.db']);
/**
 * How long the download may go without a byte before it fails. An idle limit,
 * not a total one: the tarball is the whole repository, tens of megabytes, and
 * a slow but moving connection must still finish.
 */
const IDLE_TIMEOUT_MS = 30_000;

/** Whether `dir` is missing or holds nothing an example could collide with. */
export function isEmptyDirectory(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).every((entry) => IGNORED_ENTRIES.has(entry));
}

export class ExampleDownloadError extends Error {}

/** Thrown when the caller's signal stopped the copy, such as Ctrl-C; the partial copy is already removed. */
export class ExampleCopyCancelled extends Error {}

interface CopyOptions {
  /** Called when the CLI's release tag is missing and the copy falls back to `main`. */
  readonly onFallback: (tag: string) => void;
  /** Stops the download and removes the partial copy. */
  readonly signal?: AbortSignal;
}

/** What a copy wrote, so a cancelled or failed init can take it back. */
export interface ExampleCopy {
  /** The git ref the files came from: `e2e@<version>` or `main`. */
  readonly ref: string;
  /** Removes everything the copy wrote, and the directory when the copy created it. */
  readonly remove: () => void;
}

/**
 * Downloads the tarball and writes `examples/<id>/` into `destination`, which
 * must be empty or missing. The e2e project's `package.json` takes the
 * directory's name and this CLI's ranges for e2e and its sibling packages
 * (see {@link adaptManifest}). On failure or cancellation the partial copy is
 * removed before the error is thrown.
 */
export async function copyExample(example: ExamplePreset, destination: string, { onFallback, signal }: CopyOptions): Promise<ExampleCopy> {
  const created = !existsSync(destination);
  const written = new Set<string>();
  const remove = (): void => {
    if (created) {
      rmSync(destination, { recursive: true, force: true });
      return;
    }
    for (const entry of written) rmSync(path.join(destination, entry), { recursive: true, force: true });
  };

  const tag = `e2e@${packageVersion(import.meta.url, '../../../package.json', '0.0.0')}`;
  const controller = new AbortController();
  const cancelled = new ExampleCopyCancelled('the example download was cancelled');
  const onAbort = (): void => controller.abort(cancelled);
  if (signal?.aborted === true) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stillMoving = (): void => {
    clearTimeout(timeout);
    timeout = setTimeout(
      () => controller.abort(new ExampleDownloadError(`GitHub sent nothing for ${IDLE_TIMEOUT_MS / 1000} s`)),
      IDLE_TIMEOUT_MS,
    );
  };
  /** The chunks as they arrive, each one restarting the idle limit. */
  async function* watched(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      stillMoving();
      yield chunk;
    }
  }
  stillMoving();
  try {
    let ref = tag;
    let response = await download(`refs/tags/${tag}`, controller.signal);
    if (response.status === 404) {
      onFallback(tag);
      ref = 'main';
      response = await download('refs/heads/main', controller.signal);
    }
    if (!response.ok || response.body === null) {
      throw new ExampleDownloadError(`GitHub answered ${response.status} for ${REPOSITORY}@${ref}`);
    }
    mkdirSync(destination, { recursive: true });
    const body = Readable.from(response.body);
    const gunzip = createGunzip();
    body.on('error', (cause) => gunzip.destroy(cause));
    let files: number;
    try {
      files = await extractFolder(watched(body.pipe(gunzip)), `examples/${example.id}/`, destination, (top) => written.add(top));
    } finally {
      // Extraction stops reading once it passed the folder; the rest of the download is dropped.
      gunzip.destroy();
      body.destroy();
    }
    if (files === 0) throw new ExampleDownloadError(`${REPOSITORY}@${ref} has no examples/${example.id}`);
    adaptManifest(path.join(destination, example.project), packageName(destination, example));
    return { ref, remove };
  } catch (cause) {
    remove();
    if (cause instanceof ExampleDownloadError) throw cause;
    const reason: unknown = controller.signal.aborted ? controller.signal.reason : cause;
    if (reason instanceof ExampleDownloadError || reason instanceof ExampleCopyCancelled) throw reason;
    throw new ExampleDownloadError(reason instanceof Error ? reason.message : String(reason), { cause });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

/** Requests the repository tarball for one ref. */
function download(ref: string, signal: AbortSignal): Promise<Response> {
  const encoded = ref.split('/').map(encodeURIComponent).join('/');
  return fetch(`https://codeload.github.com/${REPOSITORY}/tar.gz/${encoded}`, { headers: { 'user-agent': USER_AGENT }, signal });
}

/** The project's npm name from the directory it was copied into; the e2e project beside a native app gets `-e2e`. */
function packageName(destination: string, example: ExamplePreset): string | undefined {
  const base = path.basename(path.resolve(destination)).toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^[._-]+/u, '');
  if (base === '') return undefined;
  return example.project === '.' ? base : `${base}-e2e`;
}

/**
 * Names the copied project after its directory and points `e2e` and the
 * `@e2e-dev/*` packages at the ranges this CLI writes. An example's pins are
 * bumped by hand and can trail the release its tag marks by several minors.
 */
function adaptManifest(projectDir: string, name: string | undefined): void {
  if (!existsSync(path.join(projectDir, 'package.json'))) return;
  const { manifest, original } = readPackage(projectDir);
  const runner = packageVersion(import.meta.url, '../../../package.json', '0.0.0');
  const pin = (section: Readonly<Record<string, string>> | undefined) => section === undefined ? undefined : Object.fromEntries(
    Object.entries(section).map(([dependency, range]) => [
      dependency,
      (dependency === 'e2e' ? runner === '0.0.0' ? undefined : dependencyRange(runner) : recordedSiblingRange(dependency)) ?? range,
    ]),
  );
  const dependencies = pin(manifest.dependencies);
  const devDependencies = pin(manifest.devDependencies);
  const adapted = {
    ...manifest,
    ...(name === undefined ? {} : { name }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
  };
  writeFileSync(path.join(projectDir, 'package.json'), serializePackage(adapted, original), 'utf8');
}

/**
 * Writes the regular files of a tar stream that sit under `<root>/<folder>`
 * into `destination`, without the leading part, and stops reading once the
 * stream has moved past the folder (git archives list paths in order). Paths
 * that would leave `destination` are refused. Returns how many files were written.
 */
export async function extractFolder(
  source: AsyncIterable<Buffer>,
  folder: string,
  destination: string,
  onTopLevel: (entry: string) => void,
): Promise<number> {
  let files = 0;
  let inside = false;
  for await (const entry of readTar(source)) {
    // Every entry of a git archive sits under one `<repo>-<ref>/` directory.
    const relative = entry.path.slice(entry.path.indexOf('/') + 1);
    if (!relative.startsWith(folder)) {
      if (inside) break;
      continue;
    }
    inside = true;
    const inner = relative.slice(folder.length).replace(/\/+$/u, '');
    if (inner === '') continue;
    const segments = inner.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..') || path.isAbsolute(inner)) {
      throw new ExampleDownloadError(`the archive holds an unsafe path: ${entry.path}`);
    }
    onTopLevel(segments[0]!);
    const absolute = path.join(destination, ...segments);
    if (entry.type === 'directory') {
      mkdirSync(absolute, { recursive: true });
    } else if (entry.type === 'file') {
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, entry.data, { mode: (entry.mode & 0o111) === 0 ? 0o644 : 0o755 });
      files += 1;
    }
  }
  return files;
}

interface TarEntry {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'other';
  readonly mode: number;
  /** The file's bytes; empty for anything but a file. */
  readonly data: Buffer;
}

const BLOCK = 512;

/**
 * Parses a POSIX tar stream: ustar names with their prefix, pax `path`
 * records, and GNU long names. Links and other special entries come back as
 * `other` and are never written.
 */
async function* readTar(source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source[Symbol.asyncIterator]());
  let longName: string | undefined;
  while (true) {
    const header = await reader.read(BLOCK);
    if (header === undefined || header.every((byte) => byte === 0)) return;
    const size = octal(header.subarray(124, 136));
    const flag = String.fromCharCode(header[156] ?? 0);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (flag === 'x' || flag === 'L' || flag === 'g') {
      const body = await reader.read(padded);
      if (body === undefined) throw new ExampleDownloadError('the archive ended early');
      const content = body.subarray(0, size);
      if (flag === 'x') longName = paxPath(content) ?? longName;
      if (flag === 'L') longName = text(content);
      continue;
    }
    const name = longName ?? joinUstarName(text(header.subarray(345, 500)), text(header.subarray(0, 100)));
    longName = undefined;
    const type = flag === '0' || flag === '\0' || flag === '7' ? 'file' : flag === '5' ? 'directory' : 'other';
    let data = Buffer.alloc(0);
    if (type === 'file') {
      const body = await reader.read(padded);
      if (body === undefined) throw new ExampleDownloadError('the archive ended early');
      data = Buffer.from(body.subarray(0, size));
    } else if (!(await reader.skip(padded))) {
      throw new ExampleDownloadError('the archive ended early');
    }
    yield { path: name, type, mode: octal(header.subarray(100, 108)), data };
  }
}

/** A ustar name with its prefix field, when there is one. */
function joinUstarName(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}/${name}`;
}

/** The `path` record of a pax extended header: `<length> path=<value>\n` lines. */
function paxPath(content: Buffer): string | undefined {
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space === -1) return undefined;
    const length = Number.parseInt(content.subarray(offset, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0) return undefined;
    const record = content.subarray(space + 1, offset + length - 1).toString('utf8');
    if (record.startsWith('path=')) return record.slice('path='.length);
    offset += length;
  }
  return undefined;
}

/** A NUL-terminated header field as text. */
function text(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/** A NUL- or space-terminated octal header field. */
function octal(field: Buffer): number {
  const value = Number.parseInt(text(field).trim() || '0', 8);
  return Number.isFinite(value) ? value : 0;
}

/** Reads exact byte counts from a stream of chunks. */
class ByteReader {
  private chunks: Buffer[] = [];
  private length = 0;

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  /** The next `size` bytes, or undefined when the stream ends first. */
  async read(size: number): Promise<Buffer | undefined> {
    if (!(await this.fill(size))) return undefined;
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const rest = all.subarray(size);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return all.subarray(0, size);
  }

  /** Discards the next `size` bytes without joining them; false when the stream ends first. */
  async skip(size: number): Promise<boolean> {
    let remaining = size;
    while (remaining > 0) {
      if (this.length === 0 && !(await this.fill(1))) return false;
      const head = this.chunks[0]!;
      if (head.length <= remaining) {
        remaining -= head.length;
        this.length -= head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(remaining);
        this.length -= remaining;
        remaining = 0;
      }
    }
    return true;
  }

  private async fill(size: number): Promise<boolean> {
    while (this.length < size) {
      const next = await this.source.next();
      if (next.done === true) return false;
      this.chunks.push(next.value);
      this.length += next.value.length;
    }
    return true;
  }
}
