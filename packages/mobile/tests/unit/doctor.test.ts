/**
 * `e2e doctor` for a mobile target over a scripted client: agent-device's
 * doctor per configured device, mapped to e2e checks, and the build check.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineDoctorInfo } from 'e2e/engine';
import { harness, PROJECT_ROOT, type Harness, type HarnessOptions } from '../helpers/harness.ts';

const MACHINE = [
  { id: 'agent-device', status: 'pass', summary: 'agent-device 0.21.35' },
  { id: 'toolchain', status: 'pass', summary: 'Apple toolchain: Xcode 27.0.' },
  { id: 'session', status: 'info', summary: 'No active session.' },
  { id: 'metro', status: 'fail', summary: 'React Native dev server is not reachable.' },
];

/** A harness whose doctor answers per selected device: found when its name is in `known`. */
function doctorHarness(options: HarnessOptions, known: readonly string[] = []): Harness {
  const h = harness(options);
  h.fake.respond('command.doctor', (args) => {
    const { device, targetApp } = args as { device?: string; targetApp?: string };
    const found = device === undefined || known.includes(device);
    return {
      status: found ? 'pass' : 'fail',
      checks: [
        ...MACHINE,
        ...(found ? [{ id: 'ios-runner-cache', status: 'pass', summary: 'iOS runner artifact cached.' }] : []),
        found
          ? { id: 'device', status: 'pass', summary: '1 iOS device available; 1 booted.' }
          : { id: 'device', status: 'fail', summary: 'No iOS devices found.', hint: 'Start or create a simulator.' },
        ...(targetApp === undefined || !found ? [] : [device === undefined
          ? { id: 'target-app-device', status: 'fail', summary: 'Target app check needs one booted device; 4 matched.' }
          : { id: 'target-app', status: 'pass', summary: `Target app is launchable: ${targetApp}` }]),
      ],
    };
  });
  return h;
}

function info(h: Harness, projectRoot = PROJECT_ROOT): EngineDoctorInfo {
  return { targetName: 'ios-simulator', projectRoot, app: h.app, env: {}, headed: false, signal: new AbortController().signal, log: () => undefined };
}

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('doctor', () => {
  it('maps agent-device findings, dropping evidence, Metro, and an app check with no single booted device', async () => {
    const h = doctorHarness({});
    expect(await h.engine.doctor!(info(h))).toEqual([
      { id: 'agent-device', status: 'pass', message: 'agent-device 0.21.35' },
      { id: 'toolchain', status: 'pass', message: 'Apple toolchain: Xcode 27.0.' },
      { id: 'ios-runner-cache', status: 'pass', message: 'iOS runner artifact cached.' },
      { id: 'device', status: 'pass', message: '1 iOS device available; 1 booted.' },
    ]);
    expect(h.fake.lastArgs('command.doctor')).toMatchObject({ platform: 'ios', targetApp: 'Settings' });
    expect(h.sessions).toEqual(['e2e-ios-simulator-0']);
  });

  it('checks each configured device, machine checks once, and names the device it found missing', async () => {
    const h = doctorHarness({ device: ['Gone', 'iPhone 17'] }, ['iPhone 17']);
    expect(await h.engine.doctor!(info(h))).toEqual([
      { id: 'agent-device', status: 'pass', message: 'agent-device 0.21.35' },
      { id: 'toolchain', status: 'pass', message: 'Apple toolchain: Xcode 27.0.' },
      { id: 'device', status: 'fail', message: '"Gone": No iOS devices found. Start or create a simulator.' },
      { id: 'ios-runner-cache', status: 'pass', message: 'iOS runner artifact cached.' },
      { id: 'device', status: 'pass', message: '"iPhone 17": 1 iOS device available; 1 booted.' },
      { id: 'target-app', status: 'pass', message: '"iPhone 17": Target app is launchable: Settings' },
    ]);
  });

  it('selects a device by UDID', async () => {
    const udid = '78D5CEB4-D3A1-48E2-9AFD-6F8A99A824DA';
    const h = doctorHarness({ device: udid });
    await h.engine.doctor!(info(h));
    expect(h.fake.lastArgs('command.doctor')).toMatchObject({ platform: 'ios', udid });
  });

  it('checks the build appPath names instead of an installed app', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    writeFileSync(path.join(dir, 'App.app'), '');
    const present = doctorHarness({ appPath: 'App.app', bundleId: 'com.example.app' });
    const checks = await present.engine.doctor!(info(present, dir));
    expect(checks[0]).toEqual({ id: 'app-path', status: 'pass', message: path.join(dir, 'App.app') });
    expect(present.fake.lastArgs('command.doctor')).not.toHaveProperty('targetApp');

    const missing = doctorHarness({ appPath: 'Missing.app' });
    expect((await missing.engine.doctor!(info(missing, dir)))[0]).toMatchObject({ id: 'app-path', status: 'fail' });
  });

  it("skips the device and the build for a provider's leases without calling agent-device", async () => {
    const provider = { name: 'cloud', acquire: () => Promise.reject(new Error('unused')), release: () => Promise.resolve() };
    const h = doctorHarness({ device: provider, appPath: 'hosted.app' });
    expect(await h.engine.doctor!(info(h))).toEqual([{ id: 'device', status: 'skip', message: 'devices and the build come from the "cloud" provider' }]);
    expect(h.fake.methods()).toEqual([]);
  });
});
