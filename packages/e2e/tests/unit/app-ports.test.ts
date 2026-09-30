import { describe, expect, it } from 'vitest';
import { assignPorts, resolveConfig, type PortAssignments } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import type { TargetApp } from '../../src/types.ts';
import { allocateAppPorts } from '../../src/run/app-ports.ts';
import { snapshot } from '../helpers/snapshot.ts';

const ROOT = '/tmp/e2e-app-ports';

/** Resolves one web target per declaration, named after its key, then assigns `ports`. */
function configOf(apps: Readonly<Record<string, TargetApp>>, ports: PortAssignments = {}) {
  const config = resolveConfig(
    {
      targets: Object.entries(apps).map(([name, app]) => ({
        name,
        platform: 'web',
        engine: defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]) }),
        app,
      })),
    },
    { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
  );
  return assignPorts(config, ports);
}

/** One target named web, with its free port assigned `port`. */
function webOf(app: TargetApp, port?: number) {
  return configOf({ web: app }, port === undefined ? {} : { web: port });
}

describe('an app URL on a free port', () => {
  it('keeps the declared :0 URL and asks for a port until one is assigned', () => {
    const config = webOf({ url: 'http://127.0.0.1:0', command: { executable: 'pnpm', args: ['dev'] } });
    const app = config.targets[0]!.app;
    expect(app.base?.href).toBe('http://127.0.0.1:0/');
    expect(app.portRequest).toEqual({ host: '127.0.0.1', port: undefined });
    expect(app.site).toBe('127.0.0.1');
    expect(app.readyUrl).toBe('http://127.0.0.1:0/');
    expect(app.identity).toBe('http://127.0.0.1:0/');
    expect(webOf({ url: 'http://localhost:3000' }).targets[0]!.app.portRequest).toBeUndefined();
    expect(webOf({}).targets[0]!.app.portRequest).toBeUndefined();
  });

  it('substitutes the assigned port in the base URL and the default readyUrl, keeping the identity', () => {
    const declaration: TargetApp = { url: 'http://127.0.0.1:0/shop/', command: { executable: 'pnpm', args: ['dev'] } };
    const pending = webOf(declaration);
    const assigned = assignPorts(pending, { web: 4321 });
    const app = assigned.targets[0]!.app;
    expect(app.base).toEqual({ href: 'http://127.0.0.1:4321/shop/', origin: 'http://127.0.0.1:4321', basePath: '/shop/' });
    expect(app.portRequest).toEqual({ host: '127.0.0.1', port: 4321 });
    expect(app.readyUrl).toBe('http://127.0.0.1:4321/shop/');
    expect(app.identity).toBe(pending.targets[0]!.app.identity);
    expect(app.identity).toBe('http://127.0.0.1:0/shop/');
    expect(assigned.configDigest).toBe(pending.configDigest);
    expect(assigned.ports).toEqual({ web: 4321 });
    // A target that named its port ignores an assignment.
    expect(webOf({ url: 'http://localhost:3000' }, 4321).targets[0]!.app.base?.origin).toBe('http://localhost:3000');
  });

  it('expands {port} in the command and its readiness URL to the app port', () => {
    const app = webOf(
      {
        url: 'http://127.0.0.1:0',
        readyUrl: 'http://127.0.0.1:{port}/health',
        command: {
          executable: 'pnpm',
          args: ['dev', '--port', '{port}'],
          env: { PORT: '{port}', ORIGIN: 'http://127.0.0.1:{port}', NODE_ENV: 'test' },
        },
      },
      4321,
    ).targets[0]!.app;
    expect(app.command).toEqual({
      executable: 'pnpm',
      args: ['dev', '--port', '4321'],
      env: { PORT: '4321', ORIGIN: 'http://127.0.0.1:4321', NODE_ENV: 'test' },
    });
    expect(app.readyUrl).toBe('http://127.0.0.1:4321/health');
  });

  it('expands {port} to the fixed or default port of app.url, and refuses it without one', () => {
    expect(webOf({ url: 'http://localhost:3000', command: { executable: 'pnpm', env: { PORT: '{port}' } } }).targets[0]!.app.command?.env).toEqual({ PORT: '3000' });
    expect(webOf({ url: 'https://app.test', command: { executable: 'pnpm', args: ['{port}'] } }).targets[0]!.app.command?.args).toEqual(['443']);
    expect(() => webOf({ command: { executable: 'npx', args: ['expo', 'start', '--port', '{port}'] }, readyUrl: 'http://127.0.0.1:8081/status' })).toThrow(
      'target "web" app.command.args uses {port}, but the target declares no url to take the port from',
    );
    expect(() => webOf({ command: { executable: 'node' }, readyUrl: 'http://127.0.0.1:{port}/' })).toThrow(
      'target "web" app.readyUrl uses {port}, but the target declares no url to take the port from',
    );
  });

  it('refuses a free port nothing starts on, and reuseExisting on one', () => {
    expect(() => webOf({ url: 'http://127.0.0.1:0' })).toThrow(
      'target "web" app.url asks for a free port (port 0), but nothing starts on it: add app.command to start the app there on {port}',
    );
    expect(() => webOf({ url: 'http://127.0.0.1:0', command: { executable: 'pnpm', reuseExisting: true } })).toThrow(
      'target "web" app.command.reuseExisting cannot find an app already running on a free port: port 0 is a new port every run; give the app a fixed port, or drop reuseExisting',
    );
  });
});

describe('allocateAppPorts', () => {
  it('reserves a distinct free port per target and leaves the rest alone', async () => {
    const declared: Record<string, TargetApp> = {
      a: { url: 'http://127.0.0.1:0', command: { executable: 'pnpm', env: { PORT: '{port}' } } },
      // Only IPv4 loopback is bound here: a CI host without ::1 must not fail this.
      b: { url: 'http://127.0.0.1:0', command: { executable: 'pnpm', args: ['b'] } },
      fixed: { url: 'http://127.0.0.1:3000' },
      none: {},
    };
    const config = configOf(declared);
    const allocated = await allocateAppPorts(config);
    const [a, b, fixed, none] = allocated.targets.map((target) => target.app);
    const portA = allocated.ports['a']!;
    const portB = allocated.ports['b']!;
    expect(portA).toBeGreaterThan(0);
    expect(portB).toBeGreaterThan(0);
    expect(portA).not.toBe(portB);
    expect(Object.keys(allocated.ports).toSorted()).toEqual(['a', 'b']);
    expect(a!.base?.origin).toBe(`http://127.0.0.1:${portA}`);
    expect(a!.command?.env).toEqual({ PORT: String(portA) });
    expect(b!.base?.origin).toBe(`http://127.0.0.1:${portB}`);
    expect(fixed!.base?.origin).toBe('http://127.0.0.1:3000');
    expect(none!.base).toBeUndefined();
    expect(allocated.configDigest).toBe(config.configDigest);
    // Nothing left to assign: the config passes through untouched.
    expect(await allocateAppPorts(allocated)).toBe(allocated);
    // A worker handed the same ports resolves the same URLs.
    expect(configOf(declared, allocated.ports).targets.map((target) => target.app)).toEqual(allocated.targets.map((target) => target.app));
  });
});
