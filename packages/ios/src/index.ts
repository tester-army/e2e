/**
 * `@e2e-dev/ios`: an iOS engine that is an engine-protocol server written
 * in Swift, hosted by a UI test on the simulator. This module is its
 * client half: the manifest, the transport that starts the server, and the
 * checks only the host can make.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ConfigurationError, connectEngine, defineEngine, EngineError, type EngineHandle, type OperationContext } from 'e2e/engine';
import { MANIFEST } from './manifest.ts';
import { iosTransport, run, type IosTransportOptions } from './transport.ts';

export type { IosTransportOptions as IosOptions } from './transport.ts';

/**
 * The iOS engine for a target. Drives one simulator (`udid`, else
 * `E2E_IOS_UDID`, else the one booted) and the target's `app.bundleId`.
 * Locators resolve on the host over each observation.
 */
export function ios(options: IosTransportOptions = {}): EngineHandle {
  if (options.transition !== undefined && (!Number.isSafeInteger(options.transition) || options.transition < 0)) {
    throw new ConfigurationError('INVALID_CONFIG', 'ios: `transition` must be a non-negative integer of milliseconds');
  }
  let udid: string | undefined;
  let bundleId: string | undefined;
  const served = connectEngine({
    manifest: MANIFEST,
    transport: iosTransport(options, (opened) => {
      udid = opened;
    }),
    resolveLocators: true,
    fixtures: {
      device: (context) =>
        context.fixture(
          'device',
          {
            /** Swipes back from the screen's left edge. */
            back: () => served.session!.back!(context.operation()),
          } satisfies IosDevice,
          { back: { kind: 'resource' } },
        ),
    },
    validateApp(app, { targetName }) {
      if (app.bundleId === undefined) {
        throw new ConfigurationError('INVALID_CONFIG', `target "${targetName}": the ios engine drives the app by its bundle id; set app.bundleId`);
      }
      if (app.url !== undefined || app.launchArguments !== undefined || app.permissions !== undefined) {
        throw new ConfigurationError('INVALID_CONFIG', `target "${targetName}": the ios engine does not apply app.url, app.launchArguments, or app.permissions yet; remove them`);
      }
    },
  });

  // Relaunching and clearing the app are done from the Mac: `simctl`
  // relaunches without XCUITest's launch wait, and the app's data container
  // is a directory on this machine.
  const target = (): { udid: string; bundleId: string } => {
    if (udid === undefined || bundleId === undefined) {
      throw new EngineError('INVALID_STATE', 'the ios engine has no app to launch: init has not run', { retryable: false });
    }
    return { udid, bundleId };
  };
  const relaunch = async (operation: OperationContext, clear: boolean): Promise<void> => {
    const app = target();
    await run('xcrun', ['simctl', 'terminate', app.udid, app.bundleId], operation.signal).catch(() => undefined);
    if (clear) {
      const container = (await run('xcrun', ['simctl', 'get_app_container', app.udid, app.bundleId, 'data'], operation.signal)).trim();
      for (const folder of ['Documents', 'Library', 'tmp']) {
        await rm(path.join(container, folder), { recursive: true, force: true });
      }
    }
    await run('xcrun', ['simctl', 'launch', app.udid, app.bundleId], operation.signal);
    // The relaunch is done once the app answers an observation, as
    // XCUITest's own launch waits for it.
    const deadline = Date.now() + operation.timeoutMs;
    for (;;) {
      try {
        await served.observe!(operation);
        return;
      } catch (cause) {
        if (Date.now() > deadline || operation.signal.aborted) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };

  // The harness serves this wrapper in process, over the loopback, and the
  // wrapper calls the Swift server through `served`.
  const { capabilities: _capabilities, ...members } = served;
  return defineEngine({
    ...members,
    init: async (info) => {
      bundleId = info.app.bundleId;
      await served.init!(info);
    },
    session: {
      ...served.session,
      restart: (operation) => relaunch(operation, false),
      reset: (operation) => relaunch(operation, true),
    },
  });
}

/** The `device` fixture: the device controls a test reaches outside the screen. */
export interface IosDevice {
  back(): Promise<void>;
}
