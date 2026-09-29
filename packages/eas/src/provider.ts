/** EAS Simulators' hosted iOS simulators and Android emulators as a `DeviceProvider` for the mobile engine. */

import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceLease, DeviceProvider, DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { envValue } from './env.ts';
import { easSessions, type EasSessionState, type EasSessions } from './client.ts';

const EXPO_TOKEN = 'EXPO_TOKEN';

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

/** What `easSimulators()` takes: the Expo project, the app each simulator starts with, and the simulator itself. */
export interface EasSimulatorsOptions {
  /** The Expo project the sessions belong to: its id (`extra.eas.projectId` in the app config), not its slug. */
  readonly projectId: string;
  /**
   * EAS Build EAS installs and launches on every simulator before the session
   * is ready: a simulator build (`ios.simulator: true`) or an APK. Pair it
   * with the engine's `app` and leave `appPath` out.
   */
  readonly buildId?: string | undefined;
  /** URL of an app archive EAS downloads and installs in place of an EAS Build; excludes `buildId`. */
  readonly applicationArchiveUrl?: string | undefined;
  /** Simulator to start: an iOS device name or UDID (`iPhone 17 Pro`), or an Android AVD hardware profile (`pixel_9`). Absent, EAS picks. */
  readonly device?: string | undefined;
  /**
   * Minutes without an agent-device command after which EAS stops the
   * session. Defaults to 10. In a run with more than one slot, a session
   * still queued this long fails the lease: the sessions leased before it
   * have been idle about as long.
   */
  readonly maxIdleTimeMinutes?: number | undefined;
  /** Minutes a session may run once ready before EAS stops it. Absent, the account's cap: 40, or 115 on a high-priority plan. */
  readonly maxDurationMinutes?: number | undefined;
  /** Tags on every session, beside the run's own; EAS stores them lowercased. */
  readonly tags?: readonly string[] | undefined;
}

/**
 * EAS Simulators for `mobile({ device: easSimulators() })`: one hosted
 * simulator per worker slot, started when the run starts and stopped when it
 * ends, each driven through the agent-device daemon EAS runs beside it.
 * Every session is named after its target and slot and tagged with the run.
 * `EXPO_TOKEN` comes from the run's environment.
 */
export function easSimulators(options: EasSimulatorsOptions): DeviceProvider {
  const { projectId, buildId, applicationArchiveUrl, device, maxIdleTimeMinutes = DEFAULT_MAX_IDLE_TIME_MINUTES, maxDurationMinutes, tags = [] } = options;
  if (buildId !== undefined && applicationArchiveUrl !== undefined) {
    throw new Error('easSimulators: pass `buildId` or `applicationArchiveUrl`, not both');
  }
  const clients = new Map<string, EasSessions>();
  const clientFor = (env: DeviceRequest['env']): EasSessions => {
    const token = envValue(env, EXPO_TOKEN);
    if (token === undefined) throw new Error(`${EXPO_TOKEN} is not set`);
    let client = clients.get(token);
    if (client === undefined) {
      client = easSessions(token);
      clients.set(token, client);
    }
    return client;
  };
  return {
    name: 'eas-simulators',
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      if (request.appPath !== undefined && (buildId !== undefined || applicationArchiveUrl !== undefined)) {
        throw new Error("EAS installs the app from `buildId` or `applicationArchiveUrl`; leave the engine's `appPath` out");
      }
      const client = clientFor(request.env);
      // Not the request's signal: an interrupt that lands after EAS created the session would leave it unknown, and billed.
      const created = await client.create(
        {
          appId: projectId,
          platform: request.platform,
          name: `e2e ${request.targetName} ${request.slot + 1} of ${request.slots}`,
          tags: [...tags, 'e2e', `e2e-run:${request.runId}`, `e2e-target:${request.targetName}`],
          buildId,
          applicationArchiveUrl,
          deviceIdentifier: device,
          maxIdleTimeMinutes,
          maxRunTimeMinutes: maxDurationMinutes,
        },
        AbortSignal.timeout(60_000),
      );
      request.log(`simulator session ${created.id}, ${created.url}`);
      try {
        const session = await ready(client, created.id, request, maxIdleTimeMinutes);
        if (session.openPreviewUrl !== undefined) request.log(`watch at ${session.openPreviewUrl}`);
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
      await clientFor(context.env).stop(lease.id, context.signal);
    },
  };
}

/**
 * Polls a session until its agent-device daemon is reachable. Says once when
 * it has queued for two minutes, and gives up when it queues longer than the
 * idle limit beside other slots, boots for longer than eas-cli waits, ends,
 * or the API fails several polls in a row.
 */
async function ready(client: EasSessions, id: string, request: DeviceRequest, maxIdleTimeMinutes: number): Promise<Extract<EasSessionState, { phase: 'ready' }>> {
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
      // A lone slot has no ready sibling going idle while it waits.
      if (request.slots > 1 && now - queuedSince >= maxIdleTimeMinutes * 60_000) {
        throw new Error(
          `still queued after ${maxIdleTimeMinutes} minutes, the idle limit that stops the sessions leased before it; lower \`workers\` or raise \`maxIdleTimeMinutes\``,
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
