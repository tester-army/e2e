/**
 * `@e2e-dev/android`: an Android engine that is an engine-protocol server
 * written in Java and running on the device. This module is its client
 * half: the manifest the harness reads at config load, the transport that
 * provisions the device, and the checks only the host can make.
 */

import { ConfigurationError, connectEngine, type EngineHandle } from 'e2e/engine';
import { MANIFEST } from './manifest.ts';
import { androidTransport, type AndroidTransportOptions } from './transport.ts';

export type { AndroidTransportOptions as AndroidOptions } from './transport.ts';

/**
 * The Android engine for a target. Drives one device (`serial`, else
 * `ANDROID_SERIAL`, else the one attached) and launches the target's
 * `app.bundleId`. Locators resolve on the host over each observation.
 */
export function android(options: AndroidTransportOptions = {}): EngineHandle {
  const engine: EngineHandle = connectEngine({
    manifest: MANIFEST,
    transport: androidTransport(options),
    resolveLocators: true,
    fixtures: {
      device: (context) =>
        context.fixture(
          'device',
          {
            /** Presses the system back button. */
            back: () => engine.session!.back!(context.operation()),
          } satisfies AndroidDevice,
          { back: { kind: 'resource' } },
        ),
    },
    validateApp(app, { targetName }) {
      if (app.bundleId === undefined) {
        throw new ConfigurationError('INVALID_CONFIG', `target "${targetName}": the android engine launches the app by its package name; set app.bundleId`);
      }
      if (app.url !== undefined) {
        throw new ConfigurationError('INVALID_CONFIG', `target "${targetName}": the android engine opens no URLs; remove app.url`);
      }
      if (app.launchArguments !== undefined || app.permissions !== undefined) {
        throw new ConfigurationError('INVALID_CONFIG', `target "${targetName}": the android engine does not apply app.launchArguments or app.permissions yet; remove them`);
      }
    },
  });
  return engine;
}

/** The `device` fixture: the device controls a test reaches outside the screen. */
export interface AndroidDevice {
  back(): Promise<void>;
}
