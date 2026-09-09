/**
 * The agent-device engine for e2e: a mobile body built with the
 * public `defineEngine`, validated by the same rules and graded by the same
 * capabilities as any other engine. Core imports nothing from here; this
 * package imports the contract from `@e2edev/e2e/engine` and contributes the
 * `device` fixture the way the browser engine contributes `web`.
 */

import { createRequire } from 'node:module';
import { createAgentDeviceClient } from 'agent-device';
import { ConfigurationError, defineEngine, obj, type EngineAppDeclaration, type EngineHandle } from '@e2edev/e2e/engine';
import { createDeviceFixture } from './device.ts';
import { AgentDeviceSurface, type AgentDeviceOptions, type ClientFactory } from './surface.ts';

const surfaces = new WeakMap<EngineHandle, AgentDeviceSurface>();

/** Assembles the manifest for one surface. Exported for tests that script the client. */
export function buildEngine(surface: AgentDeviceSurface): EngineHandle {
  const handle = defineEngine({
    name: 'agent-device',
    version: ownVersion(),
    spiVersion: 1,
    workers: poolSize(surface.options),
    prepare: (info) => surface.prepare(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, options) => surface.observe(operation, options),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    swipe: (direction, momentum, operation) => surface.swipe(direction, momentum, operation),
    app: {
      ...declaredApp(surface.options),
      back: (operation) => surface.back(operation),
      ...(surface.managesApp
        ? {
            restart: (operation) => surface.restart(operation),
            clearState: (operation) => surface.clearState(operation),
          }
        : {}),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
    },
    url: (operation) => surface.url(operation),
    fixtures: {
      device: (context) => createDeviceFixture(surface, context),
    },
  });
  surfaces.set(handle, surface);
  return handle;
}

/** Creates one agent-device engine: one device session per worker, one fresh app launch per attempt. */
export function agentDevice(options: AgentDeviceOptions): EngineHandle {
  const factory: ClientFactory = (session) => createAgentDeviceClient({ session });
  return buildEngine(new AgentDeviceSurface(options, factory));
}

/**
 * Workers the engine serves per target: one per device, since two workers on
 * one simulator interleave taps. A pool names a device per worker slot.
 */
function poolSize(options: AgentDeviceOptions): number {
  const { device } = options;
  if (!Array.isArray(device)) return 1;
  if (device.length === 0) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'agentDevice: `device` is an empty pool; name at least one simulator or emulator, or omit it to use a booted one',
    );
  }
  return device.length;
}

/**
 * What the device engine declares about its app: the pinned app (else the
 * build it installs) is the identity cache and session entries key on.
 */
function declaredApp(options: AgentDeviceOptions): Pick<EngineAppDeclaration, 'identity' | 'environment'> {
  return obj({
    identity: options.identity ?? options.app ?? options.appPath,
    environment: options.environment,
  });
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
