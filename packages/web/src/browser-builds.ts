/**
 * The pinned browser builds on disk: where each platform's Chrome for
 * Testing and Firefox archives live, where their executables land in the
 * browsers cache, and how an archive is downloaded and unpacked into it.
 */

import { execFile } from 'node:child_process';
import { constants, createWriteStream, chmodSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { Entry, Options, ZipFile } from 'yauzl';

/** A build the cache holds, by the directory it is kept under. */
export type BuildName = 'chrome' | 'chrome-headless-shell' | 'firefox';

/** The operating systems the builds ship for. */
type BuildOs = 'mac' | 'linux' | 'win';

/** One platform the builds ship for, under each vendor's name for it. */
export interface BrowserPlatform {
  /** The prefix of an install's directory in the cache: `mac_arm` in `mac_arm-157.0.8103.38`. */
  readonly cacheKey: 'mac_arm' | 'mac' | 'linux' | 'linux_arm' | 'win64';
  readonly os: BuildOs;
  /** Chrome for Testing's name: the download directory and the archive's top folder. */
  readonly chrome: 'mac-arm64' | 'mac-x64' | 'linux64' | 'linux-arm64' | 'win64';
  /** Mozilla's release directory name. */
  readonly firefox: 'mac' | 'linux-x86_64' | 'linux-aarch64' | 'win64';
}

/** The platforms by `${process.platform}-${process.arch}`. Windows on Arm runs the x64 builds. */
const PLATFORMS: Readonly<Record<string, BrowserPlatform>> = {
  'darwin-arm64': { cacheKey: 'mac_arm', os: 'mac', chrome: 'mac-arm64', firefox: 'mac' },
  'darwin-x64': { cacheKey: 'mac', os: 'mac', chrome: 'mac-x64', firefox: 'mac' },
  'linux-x64': { cacheKey: 'linux', os: 'linux', chrome: 'linux64', firefox: 'linux-x86_64' },
  'linux-arm64': { cacheKey: 'linux_arm', os: 'linux', chrome: 'linux-arm64', firefox: 'linux-aarch64' },
  'win32-x64': { cacheKey: 'win64', os: 'win', chrome: 'win64', firefox: 'win64' },
  'win32-arm64': { cacheKey: 'win64', os: 'win', chrome: 'win64', firefox: 'win64' },
};

/** Each build's executable inside its install directory; `{platform}` is Chrome for Testing's platform name. */
const EXECUTABLES: Readonly<Record<BuildName, Readonly<Record<BuildOs, string>>>> = {
  'chrome-headless-shell': {
    mac: 'chrome-headless-shell-{platform}/chrome-headless-shell',
    linux: 'chrome-headless-shell-{platform}/chrome-headless-shell',
    win: 'chrome-headless-shell-{platform}/chrome-headless-shell.exe',
  },
  chrome: {
    mac: 'chrome-{platform}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    linux: 'chrome-{platform}/chrome',
    win: 'chrome-{platform}/chrome.exe',
  },
  firefox: { mac: 'Firefox.app/Contents/MacOS/firefox', linux: 'firefox/firefox', win: 'core/firefox.exe' },
};

/** Where the archives are downloaded from, unless `E2E_BROWSERS_DOWNLOAD_HOST` names a mirror. */
const DEFAULT_HOSTS: Readonly<Record<'chrome' | 'firefox', string>> = {
  chrome: 'https://storage.googleapis.com',
  firefox: 'https://archive.mozilla.org',
};

const execFileAsync = promisify(execFile);

/** The platform `platform` and `arch` run the builds as, or undefined when no build ships for it. */
export function browserPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): BrowserPlatform | undefined {
  return PLATFORMS[`${platform}-${arch}`];
}

/** The directory `build` at `buildId` is unpacked into. */
function installDirectory(cacheDir: string, build: BuildName, buildId: string, platform: BrowserPlatform): string {
  return path.join(cacheDir, build, `${platform.cacheKey}-${buildId}`);
}

/** The executable of `build` at `buildId` in the cache, whether or not it is installed. */
export function executablePath(cacheDir: string, build: BuildName, buildId: string, platform: BrowserPlatform): string {
  const relative = EXECUTABLES[build][platform.os].replace('{platform}', platform.chrome);
  return path.join(installDirectory(cacheDir, build, buildId, platform), ...relative.split('/'));
}

/** The Firefox version a `stable_<version>` build id names. */
function firefoxVersion(buildId: string): string {
  if (!buildId.startsWith('stable_')) throw new Error(`unsupported Firefox build "${buildId}"; expected stable_<version>`);
  return buildId.slice('stable_'.length);
}

/**
 * The archive URL of `build` at `buildId`. `host`, an origin such as
 * `https://mirror.example.com`, replaces the vendor's and keeps its paths.
 */
export function downloadUrl(build: BuildName, buildId: string, platform: BrowserPlatform, host?: string): string {
  if (build === 'firefox') {
    const version = firefoxVersion(buildId);
    const file = { mac: `Firefox ${version}.dmg`, linux: `firefox-${version}.tar.xz`, win: `Firefox Setup ${version}.exe` }[platform.os];
    return `${host ?? DEFAULT_HOSTS.firefox}/pub/firefox/releases/${version}/${platform.firefox}/en-US/${encodeURIComponent(file)}`;
  }
  return `${host ?? DEFAULT_HOSTS.chrome}/chrome-for-testing-public/${buildId}/${platform.chrome}/${build}-${platform.chrome}.zip`;
}

/** What `installBuild` downloads and where it puts it. */
export interface BuildInstall {
  readonly build: BuildName;
  readonly buildId: string;
  readonly platform: BrowserPlatform;
  readonly cacheDir: string;
  /** A mirror origin for the download, see `downloadUrl`. */
  readonly host?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Downloads `build` and unpacks it beside its install directory, then
 * renames it into place, so an interrupted install leaves no half-unpacked
 * build behind: the partial directory is removed on the way out.
 */
export async function installBuild(install: BuildInstall): Promise<void> {
  const target = installDirectory(install.cacheDir, install.build, install.buildId, install.platform);
  const staging = `${target}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const url = downloadUrl(install.build, install.buildId, install.platform, install.host);
    const archive = path.join(staging, decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)));
    await download(url, archive, install.signal);
    const root = path.join(staging, 'root');
    mkdirSync(root);
    await unpack(archive, root, install.platform.os, install.signal);
    rmSync(target, { recursive: true, force: true });
    renameSync(root, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Streams `url` into `file`, through a temporary name renamed once the body is complete. */
async function download(url: string, file: string, signal: AbortSignal | undefined): Promise<void> {
  try {
    const response = await fetch(url, signal === undefined ? {} : { signal });
    if (!response.ok || response.body === null) throw new Error(`${String(response.status)} ${response.statusText}`);
    const partial = `${file}.download`;
    await pipeline(Readable.from(response.body), createWriteStream(partial), signal === undefined ? {} : { signal });
    renameSync(partial, file);
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    throw new Error(`download of ${url} failed: ${failureOf(cause)}`, { cause });
  }
}

/** An error's message with its cause's, which is where fetch keeps the network error behind "fetch failed". */
function failureOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined ? error.message : `${error.message} (${failureOf(error.cause)})`;
}

/** Unpacks `archive` into `root` with the tool its format needs. */
async function unpack(archive: string, root: string, buildOs: BuildOs, signal: AbortSignal | undefined): Promise<void> {
  if (archive.endsWith('.zip')) return extractZip(archive, root, signal);
  if (archive.endsWith('.dmg')) return copyAppFromDmg(archive, root, signal);
  if (archive.endsWith('.tar.xz')) return extractTarXz(archive, root, signal);
  if (buildOs === 'win' && archive.endsWith('.exe')) {
    await execFileAsync(archive, [`/ExtractDir=${root}`], { signal, env: { ...process.env, __compat_layer: 'RunAsInvoker' } });
    return;
  }
  throw new Error(`unsupported archive ${archive}`);
}

/** Unpacks a `.tar.xz` with the system `tar`, which hands the decompression to `xz`. */
async function extractTarXz(archive: string, root: string, signal: AbortSignal | undefined): Promise<void> {
  try {
    await execFileAsync('tar', ['-xJf', archive, '-C', root], { signal });
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    const detail = (cause as { code?: unknown; stderr?: unknown }).code === 'ENOENT' ? 'tar was not found' : String((cause as { stderr?: unknown }).stderr ?? cause).trim();
    throw new Error(`could not unpack ${path.basename(archive)} with "tar -xJf": ${detail}; it needs tar and xz (Debian and Ubuntu: apt-get install xz-utils)`, { cause });
  }
}

/** Mounts a Firefox `.dmg` read-only, copies its `.app` into `root`, and detaches it again. */
async function copyAppFromDmg(archive: string, root: string, signal: AbortSignal | undefined): Promise<void> {
  const mountpoint = mkdtempSync(path.join(os.tmpdir(), 'e2e-dmg-'));
  let attached = false;
  try {
    await execFileAsync('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountpoint, archive], { signal });
    attached = true;
    const app = readdirSync(mountpoint).find((name) => name.endsWith('.app'));
    if (app === undefined) throw new Error(`no .app in ${path.basename(archive)}`);
    await execFileAsync('cp', ['-R', path.join(mountpoint, app), root], { signal });
  } finally {
    if (attached) await execFileAsync('hdiutil', ['detach', '-force', mountpoint]).catch(() => undefined);
    rmSync(mountpoint, { recursive: true, force: true });
  }
}

/** Whether `child` is `parent` or inside it. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Unpacks a zip into `root`, keeping each entry's unix mode bits and
 * symlinks. Symlinks are created after every file is written, so no entry
 * is ever written through one, and each must point inside `root`.
 */
export async function extractZip(archive: string, root: string, signal?: AbortSignal): Promise<void> {
  const { default: yauzl } = await import('yauzl');
  const zip = await promisify<string, Options, ZipFile>(yauzl.open)(archive, { lazyEntries: true, autoClose: false });
  const links: { readonly at: string; readonly target: string }[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.on('entry', (entry: Entry) => {
        extractEntry(zip, entry, root, links, signal).then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  for (const link of links) symlinkSync(link.target, link.at);
}

/** Writes one zip entry under `root`, or records it in `links` when it is a symlink. */
async function extractEntry(zip: ZipFile, entry: Entry, root: string, links: { at: string; target: string }[], signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  const destination = path.join(root, entry.fileName);
  if (!isInside(root, destination)) throw new Error(`zip entry "${entry.fileName}" is outside the archive root`);
  const mode = entry.externalFileAttributes >>> 16;
  const type = mode & constants.S_IFMT;
  if (type === constants.S_IFDIR || entry.fileName.endsWith('/')) {
    mkdirSync(destination, { recursive: true });
    return;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  const stream = await promisify<Entry, Readable>(zip.openReadStream.bind(zip))(entry);
  if (type === constants.S_IFLNK) {
    const target = await text(stream);
    if (path.isAbsolute(target) || !isInside(root, path.resolve(path.dirname(destination), target))) {
      throw new Error(`zip entry "${entry.fileName}" links outside the archive root: ${target}`);
    }
    links.push({ at: destination, target });
    return;
  }
  await pipeline(stream, createWriteStream(destination));
  chmodSync(destination, (mode & 0o777) === 0 ? 0o644 : mode & 0o777);
}
