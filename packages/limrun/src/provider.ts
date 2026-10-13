import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Limrun from '@limrun/api';
import type { AndroidInstance } from '@limrun/api/resources/android-instances';
import type { IosInstance } from '@limrun/api/resources/ios-instances';
import type { DeviceProvider, DeviceRequest } from '@e2e-dev/mobile';
import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';
import { startHeartbeat } from './heartbeat.ts';
import { assertAndroidTools, assertDriverVersion, startDriver, stopDriver } from './daemon.ts';

export interface LimrunOptions {
  /** Region preference, such as `eu` or `us-east1`. Limrun may overflow to another region. */
  readonly region?: string;
  /** Maximum device lifetime. Defaults to `1h`, including abandoned runs. */
  readonly hardTimeout?: string;
  readonly ios?: { readonly model?: 'iphone' | 'ipad' };
  readonly android?: { readonly model?: 'phone' | 'tablet'; readonly osVersion?: string };
}

type Instance = IosInstance | AndroidInstance;
type Held = { stateDir: string; env: NodeJS.ProcessEnv; client: Limrun; platform: 'ios' | 'android'; stopHeartbeat?: () => Promise<void> };

function api(env: DeviceRequest['env']): Limrun {
  const apiKey = env.LIMRUN_API_KEY?.trim();
  if (!apiKey) throw new ConfigurationError('INVALID_CONFIG', '@e2e-dev/limrun requires LIMRUN_API_KEY in the run environment');
  // Retrying a create after an ambiguous response could allocate a second device.
  return new Limrun({ apiKey, baseURL: env.LIMRUN_BASE_URL?.trim() || 'https://api.limrun.com', maxRetries: 0, timeout: 60_000, defaultHeaders: { 'X-Limrun-Client': 'e2e' } });
}

function access(instance: Instance): { apiUrl: string; token: string } {
  const { apiUrl, token } = instance.status;
  if (!apiUrl || !token) throw new Error(`Limrun instance ${instance.metadata.id} has no control endpoint or token. Use an API key with full control.`);
  return { apiUrl, token };
}

async function ready(client: Limrun, platform: 'ios' | 'android', instance: Instance, signal: AbortSignal): Promise<Instance> {
  let current = instance;
  while (true) {
    signal.throwIfAborted();
    if (current.status.state === 'ready') return current;
    if (current.status.state === 'terminated') throw new Error(`Limrun instance ${instance.metadata.id} terminated before readiness: ${current.status.errorMessage ?? current.status.terminationReason ?? 'unknown'}`);
    await sleep(500, undefined, { signal });
    try {
      current = await (platform === 'ios' ? client.iosInstances : client.androidInstances).get(instance.metadata.id, { signal });
    } catch (cause) {
      // The regional create can precede the backend read model. The caller's budget bounds readiness.
      if (!(cause instanceof Limrun.NotFoundError)) throw cause;
    }
  }
}

async function deleteInstance(client: Limrun, platform: 'ios' | 'android', id: string, signal: AbortSignal): Promise<void> {
  try {
    await (platform === 'ios' ? client.iosInstances : client.androidInstances).delete(id, { signal });
  } catch (cause) {
    // An expired or already deleted instance needs no further cleanup.
    if (!(cause instanceof Limrun.NotFoundError)) throw cause;
  }
}

function driverEnv(env: DeviceRequest['env'], instance: Instance, platform: 'ios' | 'android'): NodeJS.ProcessEnv {
  const result = { ...env };
  // A user's attached instance and daemon settings must not select a different device.
  for (const key of Object.keys(result)) {
    // Keep the user's security policy on both the daemon and its clients.
    if (key === 'AGENT_DEVICE_DAEMON_POLICY') continue;
    if (key.startsWith('LIM_IOS_INSTANCE_') || key.startsWith('LIM_ANDROID_INSTANCE_') || key.startsWith('AGENT_DEVICE_')) delete result[key];
  }
  const { apiUrl, token } = access(instance);
  const prefix = platform === 'ios' ? 'LIM_IOS_INSTANCE' : 'LIM_ANDROID_INSTANCE';
  result[`${prefix}_URL`] = apiUrl;
  result[`${prefix}_TOKEN`] = token;
  if (platform === 'android') {
    const adbUrl = (instance as AndroidInstance).status.adbWebSocketUrl;
    if (!adbUrl) throw new Error(`Limrun instance ${instance.metadata.id} has no ADB endpoint`);
    result.LIM_ANDROID_INSTANCE_ADB_URL = adbUrl;
  }
  result.LIMRUN_KEEP_ALIVE = 'true';
  return result;
}

/** One Limrun instance and isolated agent-device daemon per worker slot. */
export function limrun(options: LimrunOptions = {}): DeviceProvider {
  rejectUnknownKeys('limrun()', options, ['region', 'hardTimeout', 'ios', 'android']);
  if (options.ios) rejectUnknownKeys('limrun().ios', options.ios, ['model']);
  if (options.android) rejectUnknownKeys('limrun().android', options.android, ['model', 'osVersion']);
  const held = new Map<string, Held>();

  async function release(id: string, resource: Held, signal: AbortSignal): Promise<void> {
    await resource.stopHeartbeat?.();
    const results = await Promise.allSettled([
      stopDriver(resource.stateDir, resource.env, signal).then(() => rm(resource.stateDir, { recursive: true, force: true })),
      deleteInstance(resource.client, resource.platform, id, signal),
    ]);
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, `Could not fully release Limrun instance ${id}: ${errors.map((error: unknown) => error instanceof Error ? error.message : String(error)).join('; ')}`);
    held.delete(id);
  }

  return {
    name: 'Limrun',
    async acquire(request) {
      assertDriverVersion(request.agentDeviceVersion);
      request.signal.throwIfAborted();
      const client = api(request.env);
      if (request.platform === 'android') await assertAndroidTools({ ...request.env }, request.signal);
      const spec = { hardTimeout: options.hardTimeout ?? '1h', ...(options.region === undefined ? {} : { region: options.region }) };
      const metadata = { displayName: `e2e ${request.targetName} worker ${request.slot + 1}`, labels: { source: 'e2e', run: request.runId, target: request.targetName, slot: String(request.slot) } };
      // Receive the id even if the run is interrupted during create, so cleanup can delete it.
      const created = request.platform === 'ios'
        ? await client.iosInstances.create({ metadata, spec: { ...spec, ...options.ios } })
        : await client.androidInstances.create({ metadata, spec: { ...spec, ...(options.android?.model === undefined ? {} : { model: options.android.model }), clues: [{ kind: 'OSVersion', osVersion: options.android?.osVersion ?? '15' }] } });
      const id = created.metadata.id;
      let resource: Held | undefined;
      try {
        const stateDir = await mkdtemp(path.join(tmpdir(), 'e2e-limrun-'));
        resource = { stateDir, env: { ...request.env }, client, platform: request.platform };
        held.set(id, resource);
        request.log(`created ${id}`);
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]);
        const instance = await ready(client, request.platform, created, signal);
        resource.env = driverEnv(request.env, instance, request.platform);
        const binding = await startDriver({ stateDir, runId: request.runId, slot: request.slot, platform: request.platform, app: request.app, appPath: request.appPath }, resource.env, signal);
        resource.stopHeartbeat = await startHeartbeat(binding, request.log);
        return { id, ...binding };
      } catch (cause) {
        const signal = AbortSignal.timeout(30_000);
        try {
          if (resource) await release(id, resource, signal);
          else await deleteInstance(client, request.platform, id, signal);
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], `Limrun acquisition failed; cleanup also failed for ${id}`, { cause: cleanup });
        }
        throw cause;
      }
    },
    async release(lease, context) {
      const resource = held.get(lease.id);
      if (resource) await release(lease.id, resource, context.signal);
    },
  };
}
