/**
 * The agent-device backend for e2e (RFC0002): a mobile body built with the
 * public `defineBackend`, validated by the same rules and graded by the same
 * capabilities as any other backend. Core imports nothing from here; this
 * package imports the contract from `@e2edev/e2e/backend` and contributes the
 * `device` fixture the way the browser backend contributes `web`.
 */

import { createRequire } from 'node:module';
import { createAgentDeviceClient } from 'agent-device';
import { defineBackend, type BackendHandle } from '@e2edev/e2e/backend';
import { createDeviceFixture } from './device.ts';
import { AgentDeviceSurface, type AgentDeviceOptions, type ClientFactory } from './surface.ts';

const surfaces = new WeakMap<BackendHandle, AgentDeviceSurface>();

/** Assembles the manifest for one surface. Exported for tests that script the client. */
export function buildBackend(surface: AgentDeviceSurface): BackendHandle {
  const handle = defineBackend({
    name: 'agent-device',
    version: ownVersion(),
    spiVersion: 1,
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, options) => surface.observe(operation, options),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    swipe: (direction, momentum, operation) => surface.swipe(direction, momentum, operation),
    app: {
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

/** Creates one agent-device backend: one device session per worker, one fresh app launch per attempt. */
export function agentDevice(options: AgentDeviceOptions): BackendHandle {
  const factory: ClientFactory = (session) => createAgentDeviceClient({ session });
  return buildBackend(new AgentDeviceSurface(options, factory));
}

/** The surface behind a handle this package created; undefined for any other backend. */
export function surfaceOf(backend: BackendHandle): AgentDeviceSurface | undefined {
  return surfaces.get(backend);
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
