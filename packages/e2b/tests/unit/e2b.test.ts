/**
 * `e2b()` against a mocked `e2b` SDK, agent-device client, tunnel, and `fetch`: the create body
 * and its metadata, a sandbox closed to public traffic, the in-sandbox setup
 * and proxy, the lease's loopback daemon and serial, the build install, the
 * run's connection and the ambient variables it refuses, kill and tunnel
 * close on release and after a failure, and the configuration it refuses.
 */

import type { DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { e2b } from '../../src/index.ts';

const sdk = vi.hoisted(() => {
  class CommandExitError extends Error {
    constructor(readonly exitCode: number, readonly stdout: string, readonly stderr: string) {
      super(`exit ${exitCode}`);
    }
  }
  const state = {
    created: [] as { template: string; opts: Record<string, unknown> }[],
    commands: [] as { command: string; opts: Record<string, unknown> }[],
    killed: [] as { id: string; opts: Record<string, unknown> }[],
    setupFails: false,
    /** What `tail` of a log in the sandbox prints, with `TOKEN` standing for the proxy's token. */
    log: '',
    proxyToken: '',
    /** Aborted when setup finishes, as a run interrupted right then would be. */
    abortAfterSetup: undefined as AbortController | undefined,
    killFails: false,
    counter: 0,
  };
  const Sandbox = {
    create: async (template: string, opts: Record<string, unknown>) => {
      state.created.push({ template, opts });
      state.counter += 1;
      const sandboxId = `sbx${state.counter}`;
      return {
        sandboxId,
        trafficAccessToken: `tat-${sandboxId}`,
        getHost: (port: number) => `${port}-${sandboxId}.e2b.test`,
        commands: {
          run: async (command: string, runOpts: Record<string, unknown>) => {
            state.commands.push({ command, opts: runOpts });
            const envs = runOpts['envs'] as { PROXY_TOKEN?: string } | undefined;
            if (envs?.PROXY_TOKEN !== undefined) state.proxyToken = envs.PROXY_TOKEN;
            if (runOpts['background'] !== true) {
              if (command.startsWith('tail ')) return { exitCode: 0, stdout: state.log.replaceAll('TOKEN', state.proxyToken) };
              if (state.setupFails) throw new CommandExitError(1, '', 'npm ERR! 404');
              state.abortAfterSetup?.abort(new Error('interrupted'));
              return { exitCode: 0, stdout: '' };
            }
            return {
              wait: async () => ({ exitCode: 0, stdout: '' }),
              kill: async () => true,
              disconnect: async () => {},
            };
          },
        },
      };
    },
    kill: async (id: string, opts: Record<string, unknown>) => {
      state.killed.push({ id, opts });
      if (state.killFails) throw new Error('E2B API unavailable');
      return true;
    },
  };
  return { state, Sandbox, CommandExitError };
});

const integration = vi.hoisted(() => ({ tags: [] as (string | undefined)[] }));

vi.mock('e2b', () => ({
  Sandbox: sdk.Sandbox,
  CommandExitError: sdk.CommandExitError,
  ConnectionConfig: { setIntegration: (tag: string | undefined) => void integration.tags.push(tag) },
}));

const tunnels = vi.hoisted(() => ({ opened: [] as { host: string; trafficToken: string }[], closed: [] as string[] }));

vi.mock('../../src/tunnel.ts', () => ({
  openTunnel: async (target: { host: string; trafficToken: string }) => {
    tunnels.opened.push({ host: target.host, trafficToken: target.trafficToken });
    return { url: `http://tunnel.${target.host}`, close: async () => void tunnels.closed.push(target.host) };
  },
}));

const device = vi.hoisted(() => ({
  clients: [] as Record<string, unknown>[],
  installs: [] as Record<string, unknown>[],
  closed: 0,
  result: { package: 'com.example.app' } as Record<string, unknown>,
  installFails: false,
}));

vi.mock('agent-device', () => ({
  createAgentDeviceClient: (config: Record<string, unknown>) => {
    device.clients.push(config);
    return {
      apps: {
        install: async (options: Record<string, unknown>) => {
          device.installs.push(options);
          if (device.installFails) throw new Error('INSTALL_FAILED_INVALID_APK');
          return device.result;
        },
      },
      sessions: { close: async () => void (device.closed += 1) },
    };
  },
}));

const APK = '/builds/app.apk';

const healthy = async (_url: string) => new Response('{"ok":true}');

const health = vi.fn(healthy);

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest {
  return {
    platform: 'android',
    runId: 'run1',
    targetName: 'android',
    slot: 0,
    slots: 1,
    agentDeviceVersion: '0.21.31',
    projectRoot: '/project',
    env: { E2B_API_KEY: 'key' },
    signal: new AbortController().signal,
    log: () => {},
    ...overrides,
  };
}

function releaseContext(env: DeviceReleaseContext['env'] = { E2B_API_KEY: 'key' }): DeviceReleaseContext {
  return { runId: 'run1', targetName: 'android', env, signal: new AbortController().signal, log: () => {} };
}

beforeEach(() => {
  sdk.state.created.length = 0;
  sdk.state.commands.length = 0;
  sdk.state.killed.length = 0;
  sdk.state.setupFails = false;
  sdk.state.log = '';
  sdk.state.proxyToken = '';
  sdk.state.abortAfterSetup = undefined;
  sdk.state.killFails = false;
  tunnels.opened.length = 0;
  tunnels.closed.length = 0;
  integration.tags.length = 0;
  device.clients.length = 0;
  device.installs.length = 0;
  device.closed = 0;
  device.result = { package: 'com.example.app' };
  device.installFails = false;
  sdk.state.counter = 0;
  health.mockReset();
  health.mockImplementation(healthy);
  vi.stubGlobal('fetch', health);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('e2b()', () => {
  it('leases an android-16 sandbox whose agent-device proxy the worker connects to', async () => {
    const lines: string[] = [];
    const lease = await e2b().acquire(request({ slot: 2, log: (line) => lines.push(line) }));

    expect(sdk.state.created).toHaveLength(1);
    const { template, opts } = sdk.state.created[0]!;
    expect(template).toBe('android-16');
    expect(opts).toMatchObject({
      apiKey: 'key',
      domain: 'e2b.app',
      apiUrl: 'https://api.e2b.app',
      debug: false,
      timeoutMs: 3_600_000,
      metadata: { e2e_run: 'run1', e2e_target: 'android', e2e_slot: '2' },
      network: { allowPublicTraffic: false },
    });

    const [setup, proxy] = sdk.state.commands;
    expect(setup!.command).toContain('agent-device@0.21.31');
    expect(setup!.command).toContain('sys.boot_completed');
    expect(proxy!.command).toContain('agent-device proxy --host 0.0.0.0 --port 4310');
    const token = (proxy!.opts['envs'] as { PROXY_TOKEN: string }).PROXY_TOKEN;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(proxy!.command).not.toContain(token);
    expect(proxy!.command).toContain('--daemon-auth-token "$PROXY_TOKEN"');

    expect(tunnels.opened).toEqual([{ host: '4310-sbx1.e2b.test', trafficToken: 'tat-sbx1' }]);
    expect(lease).toEqual({ id: 'sbx1', deviceId: '127.0.0.1:5555', daemon: { baseUrl: 'http://tunnel.4310-sbx1.e2b.test', authToken: token } });
    expect(JSON.stringify(lease)).not.toContain('tat-sbx1');
    expect(health).toHaveBeenCalledWith('http://tunnel.4310-sbx1.e2b.test/health', expect.anything());
    expect(lines).toEqual(['sandbox sbx1']);
  });

  it('mints a token per lease', async () => {
    const provider = e2b();
    const first = await provider.acquire(request());
    const second = await provider.acquire(request({ slot: 1 }));
    expect(first.daemon!.authToken).not.toBe(second.daemon!.authToken);
  });

  it('creates each sandbox with its own idempotency key, so an SDK retry cannot create a second one', async () => {
    const provider = e2b();
    await provider.acquire(request());
    await provider.acquire(request({ slot: 1 }));
    const keys = sdk.state.created.map((created) => created.opts['idempotencyKey']);
    expect(keys).toEqual([expect.stringMatching(/^e2e-[0-9a-f-]{36}$/), expect.stringMatching(/^e2e-[0-9a-f-]{36}$/)]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("tags E2B requests with this package's name and version", async () => {
    await e2b().acquire(request());
    expect(integration.tags).toEqual([expect.stringMatching(/^e2e-e2b\/\d+\.\d+\.\d+/)]);
  });

  it('passes the template, lifetime, and E2B_DOMAIN through', async () => {
    await e2b({ template: 'my-android', timeoutMs: 600_000 }).acquire(request({ env: { E2B_API_KEY: 'key', E2B_DOMAIN: 'e2b.example' } }));
    expect(sdk.state.created[0]).toMatchObject({ template: 'my-android', opts: { domain: 'e2b.example', apiUrl: 'https://api.e2b.example', timeoutMs: 600_000 } });
  });

  it('kills the sandbox when the run is interrupted while it was being created', async () => {
    const controller = new AbortController();
    const create = sdk.Sandbox.create;
    sdk.Sandbox.create = async (template, opts) => {
      const sandbox = await create(template, opts);
      controller.abort(new Error('interrupted'));
      return sandbox;
    };
    try {
      await expect(e2b().acquire(request({ signal: controller.signal }))).rejects.toThrow('interrupted');
    } finally {
      sdk.Sandbox.create = create;
    }
    expect(sdk.state.killed.map((kill) => kill.id)).toEqual(['sbx1']);
    expect(sdk.state.commands).toHaveLength(0);
  });

  it('kills the sandbox when the progress line throws', async () => {
    await expect(e2b().acquire(request({ log: () => { throw new Error('reporter gone'); } }))).rejects.toThrow('reporter gone');
    expect(sdk.state.killed.map((kill) => kill.id)).toEqual(['sbx1']);
  });

  it('keeps the proxy token out of the proxy log', async () => {
    await e2b().acquire(request());
    expect(sdk.state.commands[1]!.command).toContain('>/dev/null 2>/tmp/agent-device-proxy.log');
  });

  it('waits for the proxy to answer through the public port', async () => {
    health.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(new Response('', { status: 502 }));
    await e2b().acquire(request());
    expect(health).toHaveBeenCalledTimes(3);
  });

  it('kills the sandbox when setup fails, naming the command output', async () => {
    sdk.state.setupFails = true;
    await expect(e2b().acquire(request())).rejects.toThrow(/exited 1: npm ERR! 404/);
    expect(sdk.state.killed.map((kill) => kill.id)).toEqual(['sbx1']);
  });

  it('names both failures when setup fails and the kill fails too', async () => {
    sdk.state.setupFails = true;
    sdk.state.killFails = true;
    await expect(e2b().acquire(request())).rejects.toThrow(/E2B lease failed: exited 1: npm ERR! 404; killing sandbox sbx1 also failed, so E2B ends it after timeoutMs: E2B API unavailable/);
  });

  it('starts the proxy with a signal the run cannot end once the proxy is running', async () => {
    const run = new AbortController();
    await e2b().acquire(request({ signal: run.signal }));
    const proxy = sdk.state.commands.find((command) => command.command.includes('agent-device proxy'))!;
    run.abort();
    expect((proxy.opts['signal'] as AbortSignal).aborted).toBe(false);
  });

  it('starts no proxy when the run was interrupted as setup finished, and kills the sandbox', async () => {
    const run = new AbortController();
    sdk.state.abortAfterSetup = run;
    await expect(e2b().acquire(request({ signal: run.signal }))).rejects.toThrow('interrupted');
    expect(sdk.state.commands.some((command) => command.command.includes('agent-device proxy'))).toBe(false);
    expect(sdk.state.killed.map((kill) => kill.id)).toEqual(['sbx1']);
  });

  it('names the end of the proxy\'s log when it never answers, with its token cut out', async () => {
    health.mockImplementation(async () => new Response('', { status: 502 }));
    sdk.state.log = 'EADDRINUSE: port 4310 (token TOKEN)';
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('interrupted')), 1_200);
    const failure = await e2b().acquire(request({ signal: controller.signal })).catch((cause: Error) => cause);
    expect((failure as Error).message).toMatch(/did not answer.*agent-device-proxy\.log: EADDRINUSE: port 4310 \(token <redacted>\)/);
    expect((failure as Error).message).not.toContain(sdk.state.proxyToken);
  });

  it('closes the tunnel on release even when the kill fails', async () => {
    const provider = e2b();
    const lease = await provider.acquire(request());
    sdk.state.killFails = true;
    await expect(provider.release(lease, releaseContext())).rejects.toThrow();
    expect(tunnels.closed).toEqual(['4310-sbx1.e2b.test']);
  });

  it('kills the sandbox on release with the run key and domain', async () => {
    const provider = e2b();
    const lease = await provider.acquire(request());
    await provider.release(lease, releaseContext({ E2B_API_KEY: 'key', E2B_DOMAIN: 'e2b.example' }));
    expect(sdk.state.killed).toEqual([{ id: 'sbx1', opts: expect.objectContaining({ apiKey: 'key', domain: 'e2b.example' }) }]);
    expect(tunnels.closed).toEqual(['4310-sbx1.e2b.test']);
  });

  it('closes the tunnel when the proxy never answers, and kills the sandbox', async () => {
    health.mockImplementation(async () => new Response('', { status: 502 }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('interrupted')), 1_200);
    await expect(e2b().acquire(request({ signal: controller.signal }))).rejects.toThrow(/did not answer/);
    expect(tunnels.closed).toEqual(['4310-sbx1.e2b.test']);
    expect(sdk.state.killed.map((kill) => kill.id)).toEqual(['sbx1']);
  });

  it('installs the build through the lease daemon once the proxy answers, and reports its package', async () => {
    const lease = await e2b().acquire(request({ appPath: APK }));
    expect(device.clients).toEqual([{ session: 'e2e-install-sbx1', daemonBaseUrl: 'http://tunnel.4310-sbx1.e2b.test', daemonAuthToken: lease.daemon!.authToken }]);
    expect(device.installs).toEqual([{ appPath: APK, platform: 'android', serial: '127.0.0.1:5555', signal: expect.any(AbortSignal) }]);
    expect(health).toHaveBeenCalled();
    expect(device.closed).toBe(1);
    expect(lease.installedApp).toBe('com.example.app');
  });

  it.each([
    [{ bundleId: 'com.example.bundle', package: 'com.example.package' }, 'com.example.bundle'],
    [{ appId: 'com.example.appid' }, 'com.example.appid'],
  ])('reads the installed app from %j in the order the mobile engine does', async (result, app) => {
    device.result = result;
    expect((await e2b().acquire(request({ appPath: APK }))).installedApp).toBe(app);
  });

  it("passes the target's bundleId to the install and falls back to it", async () => {
    device.result = {};
    const lease = await e2b().acquire(request({ appPath: APK, app: 'com.example.named' }));
    expect(device.installs[0]).toMatchObject({ app: 'com.example.named' });
    expect(lease.installedApp).toBe('com.example.named');
  });

  it('asks for a bundleId when agent-device reports no package, and kills the sandbox', async () => {
    device.result = {};
    await expect(e2b().acquire(request({ appPath: APK }))).rejects.toThrow(/reported no package; set app.bundleId/);
    expect(sdk.state.killed.map((kill) => kill.id)).toEqual(['sbx1']);
  });

  it('closes the install session and kills the sandbox when the install fails', async () => {
    device.installFails = true;
    await expect(e2b().acquire(request({ appPath: APK }))).rejects.toThrow(/INSTALL_FAILED_INVALID_APK/);
    expect(device.closed).toBe(1);
    expect(sdk.state.killed.map((kill) => kill.id)).toEqual(['sbx1']);
  });

  it('installs nothing and reports no app without an appPath', async () => {
    const lease = await e2b().acquire(request({ app: 'com.android.settings' }));
    expect(device.installs).toEqual([]);
    expect(lease).not.toHaveProperty('installedApp');
  });

  it('refuses a build that is not an .apk, and kills the sandbox', async () => {
    await expect(e2b().acquire(request({ appPath: '/builds/app.aab' }))).rejects.toThrow(/installs an .apk/);
    expect(sdk.state.killed.map((kill) => kill.id)).toEqual(['sbx1']);
  });

  it('refuses a sandbox URL the SDK would read from the runner process', async () => {
    vi.stubEnv('E2B_SANDBOX_URL', 'https://ambient.invalid');
    try {
      await expect(e2b().acquire(request())).rejects.toThrow(/unset E2B_SANDBOX_URL/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(sdk.state.created).toHaveLength(0);
  });

  it('turns off the debug mode E2B_DEBUG would switch on', async () => {
    vi.stubEnv('E2B_DEBUG', 'true');
    try {
      await e2b().acquire(request());
    } finally {
      vi.unstubAllEnvs();
    }
    expect(sdk.state.created[0]!.opts).toMatchObject({ debug: false });
  });

  it('passes a sandbox URL the run environment sets too', async () => {
    vi.stubEnv('E2B_SANDBOX_URL', 'https://sandbox.e2b.example');
    try {
      await e2b().acquire(request({ env: { E2B_API_KEY: 'key', E2B_SANDBOX_URL: 'https://sandbox.e2b.example' } }));
    } finally {
      vi.unstubAllEnvs();
    }
    expect(sdk.state.created[0]!.opts).toMatchObject({ sandboxUrl: 'https://sandbox.e2b.example' });
  });

  it('refuses iOS before creating a sandbox', async () => {
    await expect(e2b().acquire(request({ platform: 'ios' }))).rejects.toThrow(/Android only/);
    expect(sdk.state.created).toHaveLength(0);
  });

  it('requires E2B_API_KEY in the run environment', async () => {
    await expect(e2b().acquire(request({ env: {} }))).rejects.toThrow(/E2B_API_KEY/);
  });

  it('refuses unknown options and a bad lifetime', () => {
    expect(() => e2b({ region: 'eu' } as never)).toThrow(/region/);
    expect(() => e2b({ timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => e2b({ template: '' })).toThrow(/template/);
    expect(() => e2b({ template: 42 } as never)).toThrow(/template/);
  });

  it('refuses an agent-device version that is not a plain version', async () => {
    await expect(e2b().acquire(request({ agentDeviceVersion: '1.0.0; rm -rf /' }))).rejects.toThrow(/unexpected agent-device version/);
    expect(sdk.state.created).toHaveLength(0);
  });
});
