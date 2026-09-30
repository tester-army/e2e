/**
 * The agent-device engine for e2e: a mobile body built with the
 * public `defineEngine`, validated by the same rules and graded by the same
 * capabilities as any other engine. Core imports nothing from here; this
 * package imports the contract from `e2e/engine` and contributes the
 * `device` fixture the way the browser engine contributes `web`.
 */

import { createRequire } from 'node:module';
import { createAgentDeviceClient } from 'agent-device';
import { ConfigurationError, defineEngine, obj, type EngineAppCheckInfo, type EngineAppDeclaration, type EngineHandle } from 'e2e/engine';
import { createDeviceFixture } from './device.ts';
import type { ClientFactory, MobileOptions, MobilePlatform } from './options.ts';
import { isLink } from './links.ts';
import { DEVICE_ACTIONS, DEVICE_POINTER_ACTIONS } from './actions.ts';
import { AgentDeviceSurface, assertPermissions } from './surface.ts';

const surfaces = new WeakMap<EngineHandle, AgentDeviceSurface>();

/** Assembles the manifest for one surface. Exported for tests that script the client. */
export function buildEngine(surface: AgentDeviceSurface): EngineHandle {
  const handle = defineEngine({
    name: 'mobile',
    version: ownVersion(),
    spiVersion: 1,
    platform: surface.options.platform,
    ...(surface.pool.size === undefined ? {} : { workers: surface.pool.size }),
    prepare: (info) => surface.pool.prepare(info),
    finish: (info) => surface.pool.finish(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, options) => surface.observe(operation, options),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    actions: DEVICE_ACTIONS,
    performAt: (point, action, operation) => surface.performAt(point, action, operation),
    pointerActions: DEVICE_POINTER_ACTIONS,
    keyboard: {
      type: (text, keyboardOptions, operation) => surface.typeText(text, keyboardOptions, operation),
      press: (key, operation) => surface.pressFocusedKey(key, operation),
      dismiss: (operation) => surface.dismissKeyboard(operation.signal),
    },
    validateApp: (app, info) => validateApp(app, info, surface.options.platform),
    // No `open`: a device app has no URL to open, so the runner serves
    // `app.open()` with `restart`, the fresh launch of the pinned app, which
    // is also the device's "recreate the context".
    session: {
      back: (operation) => surface.back(operation),
      restart: (operation) => surface.restart(operation),
      reset: (operation) => surface.reset(operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
      startVideo: (operation) => surface.startVideo(operation),
      stopVideo: (operation) => surface.stopVideo(operation),
    },
    fixtures: {
      device: (context) => createDeviceFixture(surface, context),
    },
  });
  surfaces.set(handle, surface);
  return handle;
}

/** Creates one agent-device engine: one device session per worker; a test launches the pinned app with `app.open()`. */
export function mobile(options: MobileOptions): EngineHandle {
  const factory: ClientFactory = (session, connection) =>
    createAgentDeviceClient(
      obj({
        ...connection?.client,
        session,
        daemonBaseUrl: connection?.daemon?.baseUrl,
        daemonAuthToken: connection?.daemon?.authToken,
      }),
    );
  return buildEngine(new AgentDeviceSurface(options, factory));
}

/** What reaching this machine from the device will take once a device target can open a URL. */
const LOOPBACK_NOTES: Readonly<Record<MobilePlatform, string>> = {
  ios: "a simulator shares this machine's loopback, and a hosted device cannot reach it at all",
  android: "127.0.0.1 on an Android emulator is the emulator itself (this machine is 10.0.2.2), and a hosted device cannot reach this machine's loopback at all",
};

/**
 * A device target launches an installed app or a build: one of `bundleId`
 * and `appPath` is required. A URL (a website in the device's browser) is
 * not supported yet, and a link in `bundleId` is a mistake: a test opens one
 * with `device.openLink`.
 */
function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo, platform: MobilePlatform): void {
  const where = `target "${targetName}"`;
  if (app.url !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} declares app.url, but a mobile() target cannot open a website in the device's browser yet; test the installed app with app.bundleId or app.appPath. When it lands, note that ${LOOPBACK_NOTES[platform] ?? LOOPBACK_NOTES.android}`,
    );
  }
  if (app.bundleId === undefined && app.appPath === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} needs app.bundleId or app.appPath: a mobile() target launches an installed app, targets: [{ engine: mobile({ platform }), app: { bundleId: 'com.example.app' } }]`,
    );
  }
  if (app.bundleId !== undefined && isLink(app.bundleId)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} app.bundleId names an app by bundle id, package, or display name, not a link; a test opens a deep link or web link with device.openLink`,
    );
  }
  if (app.permissions !== undefined) assertPermissions(`${where} app.permissions`, app.permissions, 'INVALID_CONFIG');
}

/** The surface behind a handle this package created; undefined for any other engine. */
export function surfaceOf(engine: EngineHandle): AgentDeviceSurface | undefined {
  return surfaces.get(engine);
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
