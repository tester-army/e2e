/**
 * `@e2e-dev/ios`: an iOS engine that is an engine-protocol server written
 * in Swift, hosted by a UI test on the simulator. This module is its
 * client half: the manifest, the transport that starts the server, and the
 * checks only the host can make.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ConfigurationError, connectEngine, EngineError, type EngineHandle, type OperationContext } from 'e2e/engine';
import { MANIFEST } from './manifest.ts';
import { run } from './run.ts';
import { iosTransport, type IosTransportOptions } from './transport.ts';

export type { IosTransportOptions as IosOptions } from './transport.ts';

/**
 * The iOS engine for a target. Drives one simulator (`udid`, else
 * `E2E_IOS_UDID`, else the one booted) and the target's `app.bundleId`.
 * Locators resolve on the host over each observation.
 */
export function ios(options: IosTransportOptions = {}): EngineHandle {
  let target: { udid: string; bundleId: string | undefined } | undefined;
  // Relaunching and clearing the app are done from the Mac: `simctl`
  // relaunches without XCUITest's launch wait, and the app's data container
  // is a directory on this machine.
  const relaunch = async (operation: OperationContext, clear: boolean): Promise<void> => {
    if (target?.bundleId === undefined) {
      throw new EngineError('INVALID_STATE', 'the ios engine has no app to launch: init has not run', { retryable: false });
    }
    const { udid, bundleId } = target;
    if (clear) {
      await run('xcrun', ['simctl', 'terminate', udid, bundleId], operation.signal).catch(() => undefined);
      const container = (await run('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'data'], operation.signal)).trim();
      for (const folder of ['Documents', 'Library', 'tmp']) {
        await rm(path.join(container, folder), { recursive: true, force: true });
      }
    }
    await run('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, bundleId], operation.signal);
    // The relaunch is done once the app answers an observation, as
    // XCUITest's own launch waits for it.
    const deadline = Date.now() + operation.timeoutMs;
    for (;;) {
      try {
        await engine.observe!(operation);
        return;
      } catch (cause) {
        if (Date.now() > deadline || operation.signal.aborted) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  const engine = connectEngine({
    manifest: MANIFEST,
    transport: iosTransport(options, (udid, app) => {
      target = { udid, bundleId: app?.bundleId };
    }),
    resolveLocators: true,
    session: {
      restart: (operation) => relaunch(operation, false),
      reset: (operation) => relaunch(operation, true),
    },
    fixtures: {
      device: (context) =>
        context.fixture(
          'device',
          {
            /** Swipes back from the screen's left edge. */
            back: () => engine.session!.back!(context.operation()),
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
  return engine;
}

/** The `device` fixture: the device controls a test reaches outside the screen. */
export interface IosDevice {
  back(): Promise<void>;
}
