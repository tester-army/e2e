/**
 * The agent-device engine over a scripted client, for unit tests: a harness
 * records the sessions and connections each client was minted for, and
 * `boot` runs `init` for one worker slot.
 */

import type { EngineHandle } from 'e2e/engine';
import { buildEngine } from '../../src/engine.ts';
import type { MobileOptions } from '../../src/options.ts';
import type { DeviceConnection } from '../../src/bindings.ts';
import { AgentDeviceSurface } from '../../src/surface.ts';
import { createFakeClient, SETTINGS_SNAPSHOT, type FakeClient } from './fake-client.ts';

/** Deliberately not `process.cwd()`: relative build paths must resolve here, not there. */
export const PROJECT_ROOT = '/project';

/** The pool variable `prepare` wrote for a target, found by its readable prefix (the suffix is a digest of the name). */
export function poolVariableIn(env: NodeJS.ProcessEnv, readable: string): string {
  const key = Object.keys(env).find((candidate) => new RegExp(`^E2E_AGENT_DEVICE_POOL_${readable}_[0-9A-F]{8}$`).test(candidate));
  if (key === undefined) throw new Error(`no pool variable for ${readable} in ${Object.keys(env).join(', ')}`);
  return key;
}

export async function boot(
  engine: EngineHandle,
  targetName = 'ios-simulator',
  workerSlot = 0,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<void> {
  await engine.init!({
    runId: 'run-1',
    targetName,
    projectRoot: PROJECT_ROOT,
    app: {},
    env,
    headed: false,
    workerSlot,
    log: () => undefined,
    signal: new AbortController().signal,
  });
}

export interface Harness {
  readonly engine: EngineHandle;
  readonly fake: FakeClient;
  readonly sessions: string[];
  /** The connection each client was minted with; `undefined` is the local daemon with defaults. */
  readonly connections: (DeviceConnection | undefined)[];
  readonly surface: AgentDeviceSurface;
}

/** An engine over the scripted client; `pinned` false leaves the `app` option out. */
export function harness(options: Partial<MobileOptions> = {}, pinned = true): Harness {
  const fake = createFakeClient({
    'capture.snapshot': () => SETTINGS_SNAPSHOT,
    'apps.open': () => ({ session: 's', appName: 'Settings', appBundleId: 'com.apple.Preferences', identifiers: {} }),
    // The viewport probe's answer for a tree without geometry; tests that read pixels script a real file instead.
    'capture.screenshot': () => ({ logicalWidth: 390, logicalHeight: 844 }),
  });
  const sessions: string[] = [];
  const connections: (DeviceConnection | undefined)[] = [];
  const base: MobileOptions = pinned ? { platform: 'ios', app: 'Settings' } : { platform: 'ios' };
  const surface = new AgentDeviceSurface({ ...base, ...options }, (session, connection) => {
    sessions.push(session);
    connections.push(connection);
    return fake.client;
  });
  return { engine: buildEngine(surface), fake, sessions, connections, surface };
}
