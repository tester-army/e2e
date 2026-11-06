/**
 * Checks on the arguments a test hands `device.installApp` and
 * `device.openApp`. They run in the fixture, before the surface: the agent's
 * tools and the session hooks call the surface with options they built
 * themselves.
 */

import { rejectUnknownOptions, TestError } from 'e2e/engine';
import type { InstallAppOptions, OpenAppOptions } from './surface.ts';

const INSTALL_APP_OPTION_KEYS = ['app', 'reinstall'];

const OPEN_APP_OPTION_KEYS = ['relaunch', 'launchArguments', 'permissions'];

const LAUNCH_ARGUMENTS_HOME =
  "an install launches nothing: set the target's `app.launchArguments`, which `app.open()` passes, or call `device.openApp(app, { relaunch: true, launchArguments })`";

/** Where a launch option passed to `installApp` belongs. */
const INSTALL_APP_HINTS: Readonly<Record<string, string>> = {
  launchArguments: LAUNCH_ARGUMENTS_HOME,
  launchArgs: LAUNCH_ARGUMENTS_HOME,
  relaunch: 'an install launches nothing: call `app.open()` or `device.openApp(app, { relaunch: true })` after it',
  permissions: "an install launches nothing: set the target's `app.permissions`, or call `device.openApp(app, { relaunch: true, permissions })`",
};

/** What an `openApp` option from another API is called here. */
const OPEN_APP_HINTS: Readonly<Record<string, string>> = {
  launchArgs: 'it is `launchArguments`',
};

let warnedForegroundArguments = false;

/**
 * Refuses an options bag carrying a key `api` does not take. A key in
 * `hints` is one a test plausibly meant for another API, and the message
 * says where it goes.
 */
function rejectOptions(api: string, options: object, known: readonly string[], hints: Readonly<Record<string, string>>): void {
  const misplaced = Object.getOwnPropertyNames(options).find((key) => Object.hasOwn(hints, key));
  if (misplaced !== undefined) throw new TestError('INVALID_ARGUMENT', `${api} options has no key "${misplaced}"; ${hints[misplaced]}`);
  rejectUnknownOptions(api, options, known);
}

/** Refuses `device.installApp` arguments it would otherwise drop: a path that is not a string, or an option it does not take. */
export function assertInstallAppArguments(appPath: unknown, options: InstallAppOptions): void {
  if (appPath !== undefined && typeof appPath !== 'string') {
    throw new TestError('INVALID_ARGUMENT', `device.installApp takes the build's path first, then { ${INSTALL_APP_OPTION_KEYS.join(', ')} }`);
  }
  rejectOptions('device.installApp', options, INSTALL_APP_OPTION_KEYS, INSTALL_APP_HINTS);
}

/**
 * Refuses `device.openApp` options it would otherwise drop or garble: an
 * unknown key, or launch arguments that are not a list of strings. Launch
 * arguments without `relaunch` still go out, with a deprecation warning
 * once per worker: a running app keeps the arguments it started with.
 */
export function assertOpenAppOptions(options: OpenAppOptions): void {
  rejectOptions('device.openApp', options, OPEN_APP_OPTION_KEYS, OPEN_APP_HINTS);
  const { launchArguments } = options;
  if (launchArguments === undefined) return;
  if (!Array.isArray(launchArguments) || !launchArguments.every((argument) => typeof argument === 'string')) {
    throw new TestError('INVALID_ARGUMENT', 'device.openApp({ launchArguments }) must be an array of strings');
  }
  if (launchArguments.length === 0 || options.relaunch === true || warnedForegroundArguments) return;
  warnedForegroundArguments = true;
  process.emitWarning(
    'device.openApp({ launchArguments }) without `relaunch: true` is deprecated: a running app keeps the arguments it started with. Pass `relaunch: true`.',
    { type: 'DeprecationWarning', code: 'E2E_MOBILE_OPEN_APP_ARGUMENTS' },
  );
}
