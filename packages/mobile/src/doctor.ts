/**
 * The checks of `e2e doctor` for a mobile target: agent-device's own doctor
 * (its install, the platform toolchain, the device, the app) for each device
 * the target names, and the build `appPath` points at.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { obj, type EngineDoctorCheck, type EngineDoctorInfo } from 'e2e/engine';
import { runCommand } from './errors.ts';
import type { ClientFactory, MobileOptions } from './options.ts';
import { deviceSelection, isDeviceList } from './pool.ts';
import type { DeviceProvider } from './provider.ts';

/** Checks that apply to the whole machine, reported once however many devices the target names. */
const MACHINE_CHECKS = new Set(['agent-device', 'toolchain', 'ios-runner-cache']);

/**
 * Checks e2e drops: `metro` because only the app knows whether it loads its
 * bundle from a dev server, `target-app-device` because it only says the app
 * check had no single booted device to run on, which a run boots.
 */
const DROPPED_CHECKS = new Set(['metro', 'target-app-device']);

const CHECK_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Runs agent-device's doctor once per device the target names (once with no
 * device, for the booted one a run picks) and checks the build `appPath`
 * names. A provider's devices are not on this machine, and the provider
 * reads `appPath` its own way, so neither is checked for one.
 */
export async function mobileDoctor(options: MobileOptions, createClient: ClientFactory, session: string, info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
  const { device } = options;
  const devices = device === undefined ? [undefined] : typeof device === 'string' ? [device] : isDeviceList(device) ? device : undefined;
  if (devices === undefined) return [{ id: 'device', status: 'skip', message: `devices and the build come from the "${(device as DeviceProvider).name}" provider` }];
  const build = await buildCheck(info);
  const targetApp = info.app.appPath === undefined ? info.app.bundleId : undefined;
  const client = createClient(session);
  const checks: EngineDoctorCheck[] = [...build];
  const reported = new Set<string>();
  for (const name of devices) {
    info.log(`agent-device doctor${name === undefined ? '' : ` for "${name}"`}`);
    const result = await runCommand(
      'doctor',
      () => client.command.doctor(obj({ ...deviceSelection(options.platform, name === undefined ? undefined : { device: name }), targetApp, signal: info.signal })),
      info.signal,
    );
    for (const check of result.checks) {
      if (DROPPED_CHECKS.has(check.id) || !CHECK_ID.test(check.id)) continue;
      const status = statusOf(check.status);
      if (status === undefined) continue;
      if (MACHINE_CHECKS.has(check.id)) {
        if (reported.has(check.id)) continue;
        reported.add(check.id);
      }
      const found = status === 'pass' || check.hint === undefined ? check.summary : `${check.summary} ${check.hint}`;
      checks.push({ id: check.id, status, message: name === undefined || MACHINE_CHECKS.has(check.id) ? found : `"${name}": ${found}` });
    }
  }
  return checks;
}

/** agent-device's status as an e2e one; `info` is evidence, not a finding, so it reports nothing. */
function statusOf(status: string): EngineDoctorCheck['status'] | undefined {
  return status === 'pass' || status === 'warn' || status === 'fail' ? status : undefined;
}

/** Whether the build `appPath` names is on disk; nothing to check without one. */
async function buildCheck(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
  const { appPath } = info.app;
  if (appPath === undefined) return [];
  const resolved = path.resolve(info.projectRoot, appPath);
  try {
    await stat(resolved);
    return [{ id: 'app-path', status: 'pass', message: resolved }];
  } catch {
    return [{ id: 'app-path', status: 'fail', message: `app.appPath ${resolved} does not exist; build the app or fix the path` }];
  }
}
