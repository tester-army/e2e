import { afterEach, expect, it, vi } from 'vitest';
import { mobile } from '../../src/engine.ts';
import { bindingsVariable, encodeBindings, type SlotBinding } from '../../src/bindings.ts';
import { createFakeClient } from '../helpers/fake-client.ts';

const created = vi.hoisted(() => vi.fn());
vi.mock('agent-device', async (original) => ({
  ...await original<typeof import('agent-device')>(),
  createAgentDeviceClient: (config: unknown) => { created(config); return createFakeClient().client; },
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each([false, true])('keeps an explicit provider binding when ambient daemon settings exist, remote=%s', async (remote) => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_BASE_URL', 'http://127.0.0.1:1');
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'unrelated-token');
  vi.stubEnv('AGENT_DEVICE_DAEMON_TRANSPORT', 'http');
  const binding: SlotBinding = {
    client: { stateDir: '/leased-daemon', leaseId: 'lease-1' },
    ...(remote ? { daemon: { baseUrl: 'https://leased.example', authToken: 'lease-token' } } : {}),
  };
  const engine = mobile({ platform: 'ios', device: 'leased-device' });
  await engine.init!({
    runId: 'run', targetName: 'ios', projectRoot: '/project', app: {},
    env: { [bindingsVariable('ios')]: encodeBindings([binding]) },
    headed: false, workerSlot: 0, log() {}, signal: new AbortController().signal,
  });
  expect(created).toHaveBeenCalledWith({
    stateDir: '/leased-daemon', leaseId: 'lease-1', session: 'e2e-ios-0',
    daemonBaseUrl: remote ? 'https://leased.example' : '',
    daemonAuthToken: remote ? 'lease-token' : '',
    ...(remote ? {} : { daemonTransport: 'auto' }),
  });
  expect(process.env.AGENT_DEVICE_DAEMON_BASE_URL).toBe('http://127.0.0.1:1');
});
