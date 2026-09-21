/**
 * What one worker slot drives, and how it travels from the runner's `prepare`
 * to the worker's `init`. Every way a pool comes by devices (a configured
 * list, the booted devices it discovered, the leases a provider granted) is
 * one `DeviceSource` that ends in one `SlotBinding` per slot, so the worker
 * reads one shape through one environment variable, whatever produced it.
 */

import { createHash } from 'node:crypto';
import { EngineError, obj, type EngineFinishInfo, type EnginePrepareInfo } from 'e2e/engine';
import type { AgentDeviceOptions } from './options.ts';

/** An agent-device daemon other than the local one. */
export interface DeviceDaemon {
  /** Base URL answering agent-device's `GET /health` and `POST /rpc`. */
  readonly baseUrl: string;
  /** Bearer token the daemon expects, when it wants one. */
  readonly authToken?: string | undefined;
}

/** What one worker slot drives; `{}` leaves every choice to the local daemon. */
export interface SlotBinding {
  /** Device to select, by name or UDID; absent, the daemon picks a booted one. */
  readonly device?: string | undefined;
  /** The agent-device daemon to connect to; absent, the local one. */
  readonly daemon?: DeviceDaemon | undefined;
  /** App a provider already installed from `appPath`, so the worker installs nothing and opens this. */
  readonly installedApp?: string | undefined;
}

/**
 * Where a pool's devices come from. `bind` runs once per run and target in
 * `prepare`; `finish` releases what `bind` acquired, when anything was.
 */
export interface DeviceSource {
  /** Workers served per target, one per device, when known before `prepare`. */
  readonly size?: number | undefined;
  /** What a worker drives when its run had no `prepare`; `undefined` leaves the choice to the local daemon. */
  readonly fallback?: readonly SlotBinding[] | undefined;
  /** One binding per worker slot the run will use, `info.slots` at most and never none. */
  bind(info: EnginePrepareInfo): Promise<readonly SlotBinding[]>;
  finish?(info: EngineFinishInfo): Promise<void>;
}

/**
 * The app a slot opens fresh per attempt: the `app` option, else the app the
 * build `appPath` installed. `undefined` while a build still awaits its
 * install in `init`.
 */
export function pinnedApp(options: Pick<AgentDeviceOptions, 'app' | 'appPath'>, installedApp: string | undefined): string | undefined {
  if (options.appPath !== undefined && installedApp === undefined) return undefined;
  return options.app ?? installedApp;
}

/**
 * The most the serialized bindings of one target may occupy in a worker's
 * environment: a lease comes from third-party code, and an oversized
 * environment fails the worker spawn with an opaque error.
 */
const MAX_BINDINGS_ENV_BYTES = 16 * 1024;

/**
 * The environment variable a target's bindings travel to the workers in: the
 * name made environment-safe for reading, plus a digest of the exact name so
 * `ios-a` and `ios.a` never share a key.
 */
export function bindingsVariable(targetName: string): string {
  const readable = targetName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  const digest = createHash('sha256').update(targetName).digest('hex').slice(0, 8).toUpperCase();
  return `E2E_AGENT_DEVICE_POOL_${readable}_${digest}`;
}

/** Serializes the bindings for the environment: declared fields only, bounded. */
export function encodeBindings(bindings: readonly SlotBinding[]): string {
  const encoded = JSON.stringify(
    bindings.map((binding) =>
      obj({
        device: binding.device,
        daemon: binding.daemon === undefined ? undefined : obj({ baseUrl: binding.daemon.baseUrl, authToken: binding.daemon.authToken }),
        installedApp: binding.installedApp,
      }),
    ),
  );
  const bytes = Buffer.byteLength(encoded);
  if (bytes > MAX_BINDINGS_ENV_BYTES) {
    throw new EngineError(
      'ENGINE_FAILURE',
      `the device bindings take ${bytes} bytes; the worker environment carries at most ${MAX_BINDINGS_ENV_BYTES}`,
      { retryable: false },
    );
  }
  return encoded;
}

/** The bindings a `prepare` left in the environment, or `undefined` when there are none it can read. */
export function decodeBindings(raw: string | undefined): readonly SlotBinding[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isSlotBinding)) return parsed;
  } catch {
    // Not ours to read.
  }
  return undefined;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** A binding as JSON parses it back, or as a provider returned it: nothing the engine did not write is trusted. */
export function isSlotBinding(value: unknown): value is SlotBinding {
  if (typeof value !== 'object' || value === null) return false;
  const { device, daemon, installedApp } = value as Record<keyof SlotBinding, unknown>;
  return isOptionalString(device) && isOptionalString(installedApp) && (daemon === undefined || isDaemon(daemon));
}

function isDaemon(value: unknown): value is DeviceDaemon {
  if (typeof value !== 'object' || value === null) return false;
  const { baseUrl, authToken } = value as Record<keyof DeviceDaemon, unknown>;
  return typeof baseUrl === 'string' && isOptionalString(authToken);
}
