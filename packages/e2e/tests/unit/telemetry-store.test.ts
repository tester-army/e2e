import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preferencesPath, TelemetryStore, telemetryConfigDir } from '../../src/telemetry/store.ts';
import { NOTICE_VERSION } from '../../src/telemetry/telemetry.ts';

const temporaries: string[] = [];
const restores: (() => void)[] = [];

/** Root ignores file modes and Windows has none to speak of, so a read-only directory proves nothing there. */
const cannotRevokeWrite = process.platform === 'win32' || process.getuid?.() === 0;

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-telemetry-store-'));
  temporaries.push(dir);
  return dir;
}

/** A path whose parent is a file, so no directory can be created there. */
function unwritableDir(): string {
  const blocker = path.join(tempDir(), 'blocker');
  writeFileSync(blocker, '');
  return path.join(blocker, 'e2e');
}

/** Takes write permission away from `dir` until the test ends. */
function makeReadOnly(dir: string): void {
  chmodSync(dir, 0o500);
  restores.push(() => chmodSync(dir, 0o700));
}

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('telemetry store', () => {
  it('writes a complete file on open and keeps the id, salt, and creation time across opens', () => {
    const dir = tempDir();
    const store = TelemetryStore.open(dir)!;
    expect(store.enabled).toBe(true);
    expect(store.fresh).toBe(true);
    expect(store.anonymousId).toMatch(/^[a-f0-9]{32}$/u);
    expect(store.pathSalt).toMatch(/^[a-f0-9]{32}$/u);
    expect(store.anonymousId).not.toBe(store.pathSalt);
    const saved = JSON.parse(readFileSync(preferencesPath(dir), 'utf8')) as { createdAt: string };
    expect(Date.parse(saved.createdAt)).not.toBeNaN();
    expect(saved).toEqual({ anonymousId: store.anonymousId, salt: store.pathSalt, createdAt: saved.createdAt });
    expect(store.ageDays()).toBe(0);

    const reopened = TelemetryStore.open(dir)!;
    expect(reopened.fresh).toBe(false);
    expect(reopened.anonymousId).toBe(store.anonymousId);
    expect(reopened.pathSalt).toBe(store.pathSalt);
    expect(reopened.ageDays(Date.parse(saved.createdAt) + 3.5 * 86_400_000)).toBe(3);
    expect(reopened.saveEnabled(false)).toBe(true);
    expect(TelemetryStore.open(dir)!.enabled).toBe(false);
  });

  it('starts over from a file that is not JSON', () => {
    const dir = tempDir();
    writeFileSync(preferencesPath(dir), '{not json');
    const store = TelemetryStore.open(dir)!;
    expect(store.enabled).toBe(true);
    expect(store.fresh).toBe(true);
    expect(JSON.parse(readFileSync(preferencesPath(dir), 'utf8'))).toMatchObject({
      anonymousId: store.anonymousId,
      salt: store.pathSalt,
    });
  });

  it('leaves a file from before the creation time alone, with the age unknown', () => {
    const dir = tempDir();
    const legacy = JSON.stringify({ anonymousId: 'a'.repeat(32), salt: 'b'.repeat(32), enabled: true });
    writeFileSync(preferencesPath(dir), legacy);
    const store = TelemetryStore.open(dir)!;
    expect(store.fresh).toBe(false);
    expect(store.anonymousId).toBe('a'.repeat(32));
    expect(store.ageDays()).toBeUndefined();
    expect(readFileSync(preferencesPath(dir), 'utf8')).toBe(legacy);

    writeFileSync(preferencesPath(dir), JSON.stringify({ anonymousId: 'a'.repeat(32), salt: 'b'.repeat(32), createdAt: 'yesterday' }));
    expect(TelemetryStore.open(dir)!.ageDays()).toBeUndefined();
  });

  it('drops fields it does not know or that have the wrong shape', () => {
    const dir = tempDir();
    writeFileSync(
      preferencesPath(dir),
      JSON.stringify({ enabled: 'yes', anonymousId: 'not hex', salt: 42, notifiedAt: 5, extra: true }),
    );
    const store = TelemetryStore.open(dir)!;
    expect(store.enabled).toBe(true);
    expect(store.wasNotified(NOTICE_VERSION)).toBe(false);
    expect(store.anonymousId).toMatch(/^[a-f0-9]{32}$/u);
    expect(JSON.parse(readFileSync(preferencesPath(dir), 'utf8'))).not.toHaveProperty('extra');
  });

  it('is absent when the directory cannot be created', () => {
    expect(TelemetryStore.open(unwritableDir())).toBeUndefined();
  });

  it.skipIf(cannotRevokeWrite)('is absent when the file lacks its ids and the directory cannot be written', () => {
    const dir = tempDir();
    writeFileSync(preferencesPath(dir), JSON.stringify({ enabled: true }));
    makeReadOnly(dir);
    expect(TelemetryStore.open(dir)).toBeUndefined();
  });

  it.skipIf(cannotRevokeWrite)('reads a complete file in a directory that cannot be written', () => {
    const dir = tempDir();
    const first = TelemetryStore.open(dir)!;
    makeReadOnly(dir);
    const second = TelemetryStore.open(dir)!;
    expect(second.enabled).toBe(true);
    expect(second.anonymousId).toBe(first.anonymousId);
    // A choice that cannot reach the file says so.
    expect(second.saveEnabled(false)).toBe(false);
  });

  it('keeps an opt-out another process saved after this one opened the store', () => {
    const dir = tempDir();
    const running = TelemetryStore.open(dir)!;
    const disabler = TelemetryStore.open(dir)!;
    expect(disabler.saveEnabled(false)).toBe(true);
    // Reading the ids writes nothing, so the file still says off.
    expect(running.anonymousId).toBe(disabler.anonymousId);
    expect(running.pathSalt).toBe(disabler.pathSalt);
    expect(TelemetryStore.open(dir)!.enabled).toBe(false);
    expect(running.enabled).toBe(true);
    running.reload();
    expect(running.enabled).toBe(false);
  });

  it('remembers the notice per version', () => {
    const store = TelemetryStore.open(tempDir())!;
    expect(store.wasNotified(1)).toBe(false);
    store.markNotified(1, '2026-09-08T10:00:00.000Z');
    expect(store.wasNotified(1)).toBe(true);
    expect(store.wasNotified(2)).toBe(false);
  });

  it('resolves the config directory from XDG_CONFIG_HOME, the home directory, or APPDATA', () => {
    expect(telemetryConfigDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe(path.join('/xdg', 'e2e'));
    expect(telemetryConfigDir({ XDG_CONFIG_HOME: '  ' }, 'darwin')).toBe(path.join(os.homedir(), '.config', 'e2e'));
    expect(telemetryConfigDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32')).toBe(
      path.join('C:\\Users\\me\\AppData\\Roaming', 'e2e'),
    );
  });
});
