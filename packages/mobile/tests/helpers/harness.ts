/**
 * The agent-device engine over a scripted client, for unit tests: a harness
 * records the sessions and connections each client was minted for, carries
 * the target app the runner would hand `prepare` and `init`, and `boot` runs
 * `init` for one worker slot.
 */

import { obj, type EngineAppInfo, type EngineHandle, type EnginePrepareInfo, type EnginePrepareResult } from 'e2e/engine';
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

/** Runs `init` for one worker slot of the harness's engine, with its target app. */
export async function boot(
  { engine, app }: Pick<Harness, 'engine' | 'app'>,
  targetName = 'ios-simulator',
  workerSlot = 0,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<void> {
  await engine.init!({
    runId: 'run-1',
    targetName,
    projectRoot: PROJECT_ROOT,
    app,
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
  /** The target's app, as the runner hands it to `prepare` and `init`. */
  readonly app: EngineAppInfo;
  /** Runs the engine's `prepare` with the target's app. */
  prepare(info: Omit<EnginePrepareInfo, 'app'>): Promise<EnginePrepareResult | void>;
}

/** The engine's options and its target's app, in one literal: what a test varies. */
export type HarnessOptions = Partial<MobileOptions> & Pick<EngineAppInfo, 'bundleId' | 'appPath' | 'launchArguments' | 'permissions'>;

/** An engine over the scripted client; `pinned` false leaves the target's `bundleId` out. */
export function harness(options: HarnessOptions = {}, pinned = true): Harness {
  const fake = createFakeClient({
    'capture.snapshot': () => SETTINGS_SNAPSHOT,
    'apps.open': () => ({ session: 's', appName: 'Settings', appBundleId: 'com.apple.Preferences', identifiers: {} }),
    // The viewport probe's answer for a tree without geometry; tests that read pixels script a real file instead.
    'capture.screenshot': () => ({ logicalWidth: 390, logicalHeight: 844 }),
  });
  const sessions: string[] = [];
  const connections: (DeviceConnection | undefined)[] = [];
  const { bundleId, appPath, launchArguments, permissions, ...engineOptions } = options;
  const surface = new AgentDeviceSurface({ platform: 'ios', ...engineOptions }, (session, connection) => {
    sessions.push(session);
    connections.push(connection);
    return fake.client;
  });
  const engine = buildEngine(surface);
  const app = obj({ bundleId: bundleId ?? (pinned ? 'Settings' : undefined), appPath, launchArguments, permissions });
  return { engine, fake, sessions, connections, surface, app, prepare: (info) => engine.prepare!({ ...info, app }) };
}
