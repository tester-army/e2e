/** EAS Simulators' hosted iOS simulators and Android emulators as a `DeviceProvider` for the mobile engine. */

import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceLease, DeviceProvider, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';
import { easSessions, type EasSessionState, type EasSessions } from './client.ts';
import { EXPO_TOKEN, expoCredentials } from './credentials.ts';
import { appConfigProjectId } from './project.ts';

/**
 * EAS stops a session no agent-device command reached for this long: the
 * backstop for a run that died before the engine could release its lease.
 */
const DEFAULT_MAX_IDLE_TIME_MINUTES = 10;

/** How often a starting session is polled; a simulator takes about three minutes to queue, boot, and install a build. */
const POLL_INTERVAL_MS = 5_000;

/** A session queued this long waits for capacity, not for a machine; every session queues briefly. */
const QUEUE_NOTICE_MS = 2 * 60_000;

/** A session that left the queue and is still not ready after this long is stuck booting or installing; eas-cli gives up at the same point. */
const STARTUP_TIMEOUT_MS = 15 * 60_000;

/** State polls that may fail in a row, a blip at api.expo.dev, before the session is given up. */
const POLL_FAILURES_TOLERATED = 3;

/**
 * When EAS stops each ready session a run holds for idling, by run and
 * session id, across every `easSimulators()` of the run: targets prepare one
 * after another in the runner process, so a target's ready sessions sit idle
 * while the next target's queue.
 */
const idleDeadlines = new Map<string, Map<string, number>>();

/**
 * The project id each run reads from an app config, by run and project root,
 * across every `easSimulators()` of the run, so two targets of one app read it
 * once. A failed read is not kept.
 */
const projectIds = new Map<string, Promise<string>>();

/** Every option `easSimulators()` takes, kept equal to `EasSimulatorsOptions` by the compiler. */
const OPTION_KEYS: readonly string[] = Object.keys({
  projectId: true,
  buildId: true,
  applicationArchiveUrl: true,
  device: true,
  maxIdleTimeMinutes: true,
  maxDurationMinutes: true,
  agentDeviceVersion: true,
  tags: true,
} satisfies Record<keyof EasSimulatorsOptions, true>);

/** What `easSimulators()` takes: the Expo project, the app each simulator starts with, and the simulator itself. */
export interface EasSimulatorsOptions {
  /**
   * The Expo project the sessions belong to: its id, not its slug. Absent,
   * `extra.eas.projectId` of the app config in the project root, the id
   * `eas init` writes: `app.json` or `app.config.json` as written, a dynamic
   * `app.config.ts` or `.js` as the project's `expo config` evaluates it.
   */
  readonly projectId?: string | undefined;
  /**
   * EAS Build EAS installs and launches on every simulator before the session
   * is ready: a simulator build (`ios.simulator: true`) or an APK. Pair it
   * with the target's `app.bundleId` and leave `app.appPath` out.
   */
  readonly buildId?: string | undefined;
  /** URL of an app archive EAS downloads and installs in place of an EAS Build; excludes `buildId`. */
  readonly applicationArchiveUrl?: string | undefined;
  /** Simulator to start: an iOS device name or UDID (`iPhone 17 Pro`), or an Android AVD hardware profile (`pixel_9`). Absent, EAS picks. */
  readonly device?: string | undefined;
  /**
   * Minutes without an agent-device command after which EAS stops the
   * session. Must be a non-negative integer; zero omits the idle limit.
   * Defaults to 10, or one less than `maxDurationMinutes` when that
   * is shorter, since EAS wants it below the duration. A session still
   * queued once another session of the run has been ready for that one's
   * limit fails the lease: EAS is stopping that one.
   */
  readonly maxIdleTimeMinutes?: number | undefined;
  /** Non-negative integer minutes a session may run once ready before EAS stops it. Absent, the account's cap: 40, or 115 on a high-priority plan. */
  readonly maxDurationMinutes?: number | undefined;
  /**
   * The agent-device version EAS starts the session's daemon at. Defaults to
   * the one `@e2e-dev/mobile` pins, so the remote daemon answers as the
   * engine's client expects; EAS otherwise starts the latest.
   */
  readonly agentDeviceVersion?: string | undefined;
  /** Tags on every session, beside the run's own; EAS stores them lowercased. */
  readonly tags?: readonly string[] | undefined;
}

/**
 * EAS Simulators for `mobile({ device: easSimulators() })`: one hosted
 * simulator per worker slot, started when the run starts and stopped when it
 * ends, each driven through the agent-device daemon EAS runs beside it.
 * Every session is named after its target and slot and tagged with the run,
 * in the project `projectId` names or the app config links.
 * It authenticates with `EXPO_TOKEN` from the run's environment, else with
 * the session `eas login` stored, as eas-cli does.
 */
export function easSimulators(options: EasSimulatorsOptions = {}): DeviceProvider {
  rejectUnknownKeys('easSimulators()', options, OPTION_KEYS);
  for (const key of ['maxIdleTimeMinutes', 'maxDurationMinutes'] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new ConfigurationError('INVALID_CONFIG', `easSimulators: \`${key}\` must be a non-negative integer`);
    }
  }
  const { projectId, buildId, applicationArchiveUrl, device, maxDurationMinutes, agentDeviceVersion, tags = [] } = options;
  if (buildId !== undefined && applicationArchiveUrl !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', 'easSimulators: pass `buildId` or `applicationArchiveUrl`, not both');
  }
  if (options.maxIdleTimeMinutes !== undefined && maxDurationMinutes !== undefined && options.maxIdleTimeMinutes >= maxDurationMinutes) {
    throw new ConfigurationError('INVALID_CONFIG', 'easSimulators: `maxIdleTimeMinutes` must be below `maxDurationMinutes`, as EAS requires');
  }
  const idleMinutes = options.maxIdleTimeMinutes ?? (maxDurationMinutes === undefined ? DEFAULT_MAX_IDLE_TIME_MINUTES : Math.min(DEFAULT_MAX_IDLE_TIME_MINUTES, maxDurationMinutes - 1));
  // EAS takes no idle limit of zero; a session that short runs to its duration.
  const maxIdleTimeMinutes = idleMinutes >= 1 ? idleMinutes : undefined;
  const projectIdFor = (request: DeviceRequest): Promise<string> => {
    if (projectId !== undefined) return Promise.resolve(projectId);
    // The peer range admits an @e2e-dev/mobile from before providers were told the project root.
    if (typeof request.projectRoot !== 'string') {
      return Promise.reject(new Error('reading `projectId` from the app config needs an @e2e-dev/mobile that passes `projectRoot` to device providers; upgrade it, or pass `projectId`'));
    }
    const key = `${request.runId}\0${request.projectRoot}`;
    let resolved = projectIds.get(key);
    if (resolved === undefined) {
      resolved = appConfigProjectId(request.projectRoot, request.env, request.signal);
      projectIds.set(key, resolved);
      resolved.catch(() => projectIds.delete(key));
    }
    return resolved;
  };
  const clients = new Map<string, EasSessions>();
  /** The client each lease was created with, so `release` stops it as the same account even if the eas-cli login changed during the run. */
  const leaseClients = new Map<string, EasSessions>();
  const clientFor = async (env: DeviceRequest['env']): Promise<EasSessions> => {
    const credentials = await expoCredentials(env);
    if (credentials === undefined) throw new Error(`${EXPO_TOKEN} is not set and eas-cli is not logged in; run \`eas login\` or set ${EXPO_TOKEN}`);
    const key = 'accessToken' in credentials ? `token:${credentials.accessToken}` : `session:${credentials.sessionSecret}`;
    let client = clients.get(key);
    if (client === undefined) {
      client = easSessions(credentials);
      clients.set(key, client);
    }
    return client;
  };
  return {
    name: 'eas-simulators',
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      request.signal.throwIfAborted();
      if (request.appPath !== undefined && (buildId !== undefined || applicationArchiveUrl !== undefined)) {
        throw new Error("EAS installs the app from `buildId` or `applicationArchiveUrl`; leave the target's `app.appPath` out");
      }
      const appId = await projectIdFor(request);
      const client = await clientFor(request.env);
      request.signal.throwIfAborted();
      // Not the request's signal: an interrupt that lands after EAS created the session would leave it unknown, and billed.
      const created = await client.create(
        {
          appId,
          platform: request.platform,
          name: `e2e ${request.targetName} ${request.slot + 1} of ${request.slots}`,
          tags: [...tags, 'e2e', `e2e-run:${request.runId}`, `e2e-target:${request.targetName}`],
          buildId,
          applicationArchiveUrl,
          deviceIdentifier: device,
          maxIdleTimeMinutes,
          maxRunTimeMinutes: maxDurationMinutes,
          packageVersion: agentDeviceVersion ?? request.agentDeviceVersion,
        },
        AbortSignal.timeout(60_000),
      );
      request.log(`simulator session ${created.id}, ${created.url}`);
      try {
        const session = await ready(client, created.id, request);
        if (session.openPreviewUrl !== undefined) request.log(`watch at ${session.openPreviewUrl}`);
        if (maxIdleTimeMinutes !== undefined) {
          let held = idleDeadlines.get(request.runId);
          if (held === undefined) {
            held = new Map();
            idleDeadlines.set(request.runId, held);
          }
          held.set(created.id, Date.now() + maxIdleTimeMinutes * 60_000);
        }
        leaseClients.set(created.id, client);
        return { id: created.id, daemon: { baseUrl: session.daemonUrl, authToken: session.daemonToken } };
      } catch (cause) {
        // EAS bills a session from the moment it starts, and the engine holds only leases `acquire` returned.
        const outcome = await client.stop(created.id, AbortSignal.timeout(10_000)).then(
          () => 'stopped it',
          (stopCause: unknown) => `stopping it failed, so EAS stops it at its idle or duration limit (${stopCause instanceof Error ? stopCause.message : String(stopCause)})`,
        );
        const reason = request.signal.aborted ? 'cancelled' : cause instanceof Error ? cause.message : String(cause);
        throw new Error(`simulator session ${created.id} did not become ready: ${reason}; ${outcome}, ${created.url}`, { cause });
      }
    },
    async release(lease: DeviceLease, context: DeviceReleaseContext): Promise<void> {
      for (const key of projectIds.keys()) if (key.startsWith(`${context.runId}\0`)) projectIds.delete(key);
      const held = idleDeadlines.get(context.runId);
      held?.delete(lease.id);
      if (held?.size === 0) idleDeadlines.delete(context.runId);
      const client = leaseClients.get(lease.id) ?? (await clientFor(context.env));
      await client.stop(lease.id, context.signal);
      leaseClients.delete(lease.id);
    },
  };
}

/**
 * Polls a session until its agent-device daemon is reachable. Says once when
 * it has queued for two minutes, and gives up when it is still queued once
 * another session of the run has idled to its limit, boots for longer than
 * eas-cli waits, ends, or the API fails several polls in a row. The idle
 * clock counts from ready: warm-up commands may reset it at EAS, so the give
 * up can come that much early, never late.
 */
async function ready(client: EasSessions, id: string, request: DeviceRequest): Promise<Extract<EasSessionState, { phase: 'ready' }>> {
  const queuedSince = Date.now();
  let startedAt: number | undefined;
  let noticed = false;
  let failures = 0;
  for (;;) {
    let state: EasSessionState;
    try {
      state = await client.state(id, request.signal);
      failures = 0;
    } catch (cause) {
      failures += 1;
      if (request.signal.aborted || failures > POLL_FAILURES_TOLERATED) throw cause;
      await sleep(POLL_INTERVAL_MS, undefined, { signal: request.signal });
      continue;
    }
    if (state.phase === 'ready') return state;
    if (state.phase === 'ended') throw new Error(`session ${state.status}`);
    const now = Date.now();
    if (state.phase === 'queued') {
      if (now >= Math.min(...(idleDeadlines.get(request.runId)?.values() ?? []))) {
        throw new Error(
          'still queued while another session of this run idled to its `maxIdleTimeMinutes`, where EAS stops it; lower `workers` or raise `maxIdleTimeMinutes`',
        );
      }
      if (!noticed && now - queuedSince >= QUEUE_NOTICE_MS) {
        noticed = true;
        request.log('still queued at EAS after two minutes; tests start once every worker has a simulator');
      }
    } else {
      startedAt ??= now;
      if (now - startedAt >= STARTUP_TIMEOUT_MS) throw new Error(`still starting after ${STARTUP_TIMEOUT_MS / 60_000} minutes`);
    }
    await sleep(POLL_INTERVAL_MS, undefined, { signal: request.signal });
  }
}
