/**
 * `androidTransport` against a fake adb: a script that answers `adb devices`
 * from `FAKE_ADB_DEVICES` and logs every call, so the device choice and the
 * checks before anything reaches a device run without one.
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { androidTransport } from '../../src/transport.ts';

const dir = mkdtempSync(join(tmpdir(), 'e2e-android-test-'));
const adb = join(dir, 'adb');
const calls = join(dir, 'calls.log');
const builtApk = join(dir, 'server.apk');
writeFileSync(builtApk, 'apk');
writeFileSync(adb, `#!/bin/sh\necho "$@" >> "${calls}"\nif [ "$1" = devices ]; then printf 'List of devices attached\\n%b' "$FAKE_ADB_DEVICES"; fi\n`);
chmodSync(adb, 0o755);

/** Opens the transport with `devices` attached, as `adb devices` lists them. */
function open(devices: string, options: { serial?: string; serverApk?: string } = {}, env: Record<string, string> = {}) {
  process.env['FAKE_ADB_DEVICES'] = devices;
  writeFileSync(calls, '');
  return androidTransport({ adb, serverApk: builtApk, ...options }).open({ role: 'run', env, cwd: dir, signal: new AbortController().signal });
}

describe('androidTransport', () => {
  it('refuses to guess with no device attached', async () => {
    await expect(open('')).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('found no device') });
  });

  it('refuses to guess between two devices and names both', async () => {
    await expect(open('emulator-5554\\tdevice\\nemulator-5556\\tdevice\\n')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('emulator-5554, emulator-5556'),
    });
  });

  it('skips devices that are offline or unauthorized', async () => {
    await expect(open('emulator-5554\\toffline\\nR58M\\tunauthorized\\n')).rejects.toMatchObject({ message: expect.stringContaining('found no device') });
  });

  it('names the build command when the server APK is missing', async () => {
    await expect(open('emulator-5554\\tdevice\\n', { serverApk: join(dir, 'missing.apk') })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('build:server'),
    });
  });

  it('takes ANDROID_SERIAL over the attached devices without listing them', async () => {
    await expect(open('', { serverApk: join(dir, 'missing.apk') }, { ANDROID_SERIAL: 'R58M' })).rejects.toMatchObject({ message: expect.stringContaining('build:server') });
    expect(readFileSync(calls, 'utf8')).not.toContain('devices');
  });
});
