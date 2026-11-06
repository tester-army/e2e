import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserPlatform, downloadUrl, executablePath, extractZip, type BrowserPlatform } from '../../src/browser-builds.ts';

/** One entry of a generated zip: its name, its unix mode with the file type bits, and its content (a symlink's target). */
interface ZipEntry {
  readonly name: string;
  readonly mode: number;
  readonly content?: string;
}

/** A zip of `entries`, stored uncompressed and made on unix, so each entry's mode sits in its external attributes. */
function zipOf(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.content ?? '');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const DIR = 0o040000;
const FILE = 0o100000;
const LINK = 0o120000;

const MAC_ARM = browserPlatform('darwin', 'arm64')!;
const LINUX = browserPlatform('linux', 'x64')!;
const LINUX_ARM = browserPlatform('linux', 'arm64')!;
const WIN = browserPlatform('win32', 'x64')!;

describe('browserPlatform', () => {
  it.each([
    ['darwin', 'arm64', { cacheKey: 'mac_arm', os: 'mac', chrome: 'mac-arm64', firefox: 'mac' }],
    ['darwin', 'x64', { cacheKey: 'mac', os: 'mac', chrome: 'mac-x64', firefox: 'mac' }],
    ['linux', 'x64', { cacheKey: 'linux', os: 'linux', chrome: 'linux64', firefox: 'linux-x86_64' }],
    ['linux', 'arm64', { cacheKey: 'linux_arm', os: 'linux', chrome: 'linux-arm64', firefox: 'linux-aarch64' }],
    ['win32', 'x64', { cacheKey: 'win64', os: 'win', chrome: 'win64', firefox: 'win64' }],
    ['win32', 'arm64', { cacheKey: 'win64', os: 'win', chrome: 'win64', firefox: 'win64' }],
  ] as const)('maps %s %s', (platform, arch, expected) => {
    expect(browserPlatform(platform, arch)).toEqual(expected);
  });

  it.each([['win32', 'ia32'], ['linux', 'ppc64'], ['freebsd', 'x64'], ['aix', 'ppc64']] as const)('has no builds for %s %s', (platform, arch) => {
    expect(browserPlatform(platform, arch)).toBeUndefined();
  });
});

describe('downloadUrl', () => {
  it.each([
    ['chrome-headless-shell', MAC_ARM, 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/mac-arm64/chrome-headless-shell-mac-arm64.zip'],
    ['chrome', LINUX, 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/linux64/chrome-linux64.zip'],
    ['chrome-headless-shell', LINUX_ARM, 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/linux-arm64/chrome-headless-shell-linux-arm64.zip'],
    ['chrome', WIN, 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/win64/chrome-win64.zip'],
  ] as const)('points %s at Chrome for Testing', (build, platform, url) => {
    expect(downloadUrl(build, '157.0.8103.38', platform)).toBe(url);
  });

  it.each([
    [MAC_ARM, 'https://archive.mozilla.org/pub/firefox/releases/159.0.1/mac/en-US/Firefox%20159.0.1.dmg'],
    [LINUX, 'https://archive.mozilla.org/pub/firefox/releases/159.0.1/linux-x86_64/en-US/firefox-159.0.1.tar.xz'],
    [LINUX_ARM, 'https://archive.mozilla.org/pub/firefox/releases/159.0.1/linux-aarch64/en-US/firefox-159.0.1.tar.xz'],
    [WIN, 'https://archive.mozilla.org/pub/firefox/releases/159.0.1/win64/en-US/Firefox%20Setup%20159.0.1.exe'],
  ] as const)('points firefox on %o at the Mozilla archive', (platform, url) => {
    expect(downloadUrl('firefox', 'stable_159.0.1', platform)).toBe(url);
  });

  it('keeps the paths on a mirror host', () => {
    expect(downloadUrl('chrome', '157.0.8103.38', LINUX, 'http://mirror.test:8080')).toBe('http://mirror.test:8080/chrome-for-testing-public/157.0.8103.38/linux64/chrome-linux64.zip');
    expect(downloadUrl('firefox', 'stable_159.0.1', LINUX, 'http://mirror.test')).toBe('http://mirror.test/pub/firefox/releases/159.0.1/linux-x86_64/en-US/firefox-159.0.1.tar.xz');
  });

  it('refuses a Firefox build that is not a stable release', () => {
    expect(() => downloadUrl('firefox', 'nightly_160.0a1', LINUX)).toThrow('unsupported Firefox build "nightly_160.0a1"');
  });
});

describe('executablePath', () => {
  const cache = path.join(path.sep, 'cache');

  it.each([
    ['chrome-headless-shell', MAC_ARM, '157.0.8103.38', 'chrome-headless-shell/mac_arm-157.0.8103.38/chrome-headless-shell-mac-arm64/chrome-headless-shell'],
    ['chrome-headless-shell', LINUX, '157.0.8103.38', 'chrome-headless-shell/linux-157.0.8103.38/chrome-headless-shell-linux64/chrome-headless-shell'],
    ['chrome-headless-shell', WIN, '157.0.8103.38', 'chrome-headless-shell/win64-157.0.8103.38/chrome-headless-shell-win64/chrome-headless-shell.exe'],
    ['chrome', MAC_ARM, '157.0.8103.38', 'chrome/mac_arm-157.0.8103.38/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    ['chrome', LINUX_ARM, '157.0.8103.38', 'chrome/linux_arm-157.0.8103.38/chrome-linux-arm64/chrome'],
    ['chrome', WIN, '157.0.8103.38', 'chrome/win64-157.0.8103.38/chrome-win64/chrome.exe'],
    ['firefox', MAC_ARM, 'stable_159.0.1', 'firefox/mac_arm-stable_159.0.1/Firefox.app/Contents/MacOS/firefox'],
    ['firefox', LINUX, 'stable_159.0.1', 'firefox/linux-stable_159.0.1/firefox/firefox'],
    ['firefox', WIN, 'stable_159.0.1', 'firefox/win64-stable_159.0.1/core/firefox.exe'],
  ] as const)('places %s on %o', (build, platform, buildId, relative) => {
    expect(executablePath(cache, build, buildId, platform as BrowserPlatform)).toBe(path.join(cache, ...relative.split('/')));
  });
});

describe('extractZip', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-zip-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Writes `entries` as a zip and extracts it into `root`, resolving to `root`. */
  const extract = async (entries: readonly ZipEntry[]): Promise<string> => {
    const archive = path.join(dir, 'fixture.zip');
    writeFileSync(archive, zipOf(entries));
    const root = path.join(dir, 'root');
    await extractZip(archive, root);
    return root;
  };

  it.skipIf(process.platform === 'win32')('keeps unix mode bits and symlinks, including links listed before their targets', async () => {
    const root = await extract([
      { name: 'App.framework/', mode: DIR | 0o755 },
      { name: 'App.framework/Current', mode: LINK | 0o755, content: 'Versions/A' },
      { name: 'App.framework/Resources', mode: LINK | 0o755, content: 'Current/Resources' },
      { name: 'App.framework/Versions/A/Resources/data.txt', mode: FILE | 0o644, content: 'data' },
      { name: 'App.framework/Versions/A/app', mode: FILE | 0o755, content: '#!/bin/sh\n' },
      { name: 'readonly.txt', mode: FILE | 0o400, content: 'r' },
    ]);
    expect(statSync(path.join(root, 'App.framework/Versions/A/app')).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(root, 'App.framework/Versions/A/Resources/data.txt')).mode & 0o777).toBe(0o644);
    expect(statSync(path.join(root, 'readonly.txt')).mode & 0o777).toBe(0o400);
    expect(lstatSync(path.join(root, 'App.framework/Current')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(root, 'App.framework/Current'))).toBe('Versions/A');
    expect(readFileSync(path.join(root, 'App.framework/Resources/data.txt'), 'utf8')).toBe('data');
  });

  it('defaults an entry without unix attributes to a readable file', async () => {
    const root = await extract([{ name: 'plain.txt', mode: 0, content: 'plain' }]);
    expect(readFileSync(path.join(root, 'plain.txt'), 'utf8')).toBe('plain');
    if (process.platform !== 'win32') expect(statSync(path.join(root, 'plain.txt')).mode & 0o777).toBe(0o644);
  });

  it.each([
    ['link', '../escape'],
    ['a/link', '../../escape'],
    ['a/link', '/abs'],
  ])('refuses %s linking to %s outside the archive', async (name, target) => {
    await expect(extract([{ name, mode: LINK | 0o755, content: target }])).rejects.toThrow('links outside the archive root');
  });

  it('refuses an entry that climbs out of the archive', async () => {
    await expect(extract([{ name: '../escape.txt', mode: FILE | 0o644, content: 'x' }])).rejects.toThrow();
  });

  it('stops at an aborted signal', async () => {
    const archive = path.join(dir, 'fixture.zip');
    writeFileSync(archive, zipOf([{ name: 'a.txt', mode: FILE | 0o644, content: 'a' }]));
    await expect(extractZip(archive, path.join(dir, 'root'), AbortSignal.abort())).rejects.toThrow();
  });
});
