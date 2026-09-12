import { describe, expect, it } from 'vitest';
import { assignPorts, resolveConfig, type PortAssignments } from '../../src/config/resolve.ts';
import { defineEngine, type EngineAppDeclaration } from '../../src/engine/index.ts';
import { allocateAppPorts, assignedPorts } from '../../src/run/app-ports.ts';
import { snapshot } from '../helpers/snapshot.ts';

const ROOT = '/tmp/e2e-app-ports';

/** Resolves one web target per declaration, named after its key, with the given port assignments. */
function configOf(apps: Readonly<Record<string, EngineAppDeclaration>>, ports?: PortAssignments) {
  return resolveConfig(
    {
      targets: Object.entries(apps).map(([name, app]) => ({
        name,
        platform: 'web',
        engine: defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]), app }),
      })),
    },
    { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv, ...(ports === undefined ? {} : { ports }) },
  );
}

function appOf(app: EngineAppDeclaration, port?: number) {
  return configOf({ web: app }, port === undefined ? undefined : { web: port }).targets[0]!.app;
}

describe('port requests', () => {
  it('keeps the declared :0 URL and records the request until a port is assigned', () => {
    const app = appOf({ url: 'http://127.0.0.1:0', command: { executable: 'pnpm', args: ['dev'] } });
    expect(app.base?.href).toBe('http://127.0.0.1:0/');
    expect(app.portRequest).toEqual({ host: '127.0.0.1', port: undefined });
    expect(app.site).toBe('127.0.0.1');
    expect(app.readyUrl).toBe('http://127.0.0.1:0/');
    expect(app.identity).toBe('http://127.0.0.1:0/');
    expect(appOf({ url: 'http://localhost:3000' }).portRequest).toBeUndefined();
    expect(appOf({}).portRequest).toBeUndefined();
  });

  it('substitutes the assigned port in the base URL and the default readyUrl, keeping the identity', () => {
    const declaration: EngineAppDeclaration = {
      url: 'http://127.0.0.1:0/shop/',
      command: { executable: 'pnpm', args: ['dev'] },
    };
    const pending = configOf({ web: declaration });
    const assigned = assignPorts(pending, { web: 4321 });
    const app = assigned.targets[0]!.app;
    expect(app.base).toEqual({ href: 'http://127.0.0.1:4321/shop/', origin: 'http://127.0.0.1:4321', basePath: '/shop/' });
    expect(app.portRequest).toEqual({ host: '127.0.0.1', port: 4321 });
    expect(app.readyUrl).toBe('http://127.0.0.1:4321/shop/');
    expect(app.identity).toBe(pending.targets[0]!.app.identity);
    expect(app.identity).toBe('http://127.0.0.1:0/shop/');
    expect(assigned.configDigest).toBe(pending.configDigest);
    // Resolving with the ports up front lands on the same app as assigning them afterwards.
    expect(configOf({ web: declaration }, { web: 4321 }).targets[0]!.app).toEqual(app);
    // A target that named its port ignores an assignment.
    expect(assignPorts(configOf({ web: { url: 'http://localhost:3000' } }), { web: 4321 }).targets[0]!.app.base?.origin).toBe(
      'http://localhost:3000',
    );
  });

  it('expands {port} in the command, the readiness URLs, the services, and their teardowns', () => {
    const app = appOf(
      {
        url: 'http://127.0.0.1:0',
        readyUrl: 'http://127.0.0.1:{port}/health',
        command: {
          executable: 'pnpm',
          args: ['dev', '--port', '{port}'],
          env: { PORT: '{port}', ORIGIN: 'http://127.0.0.1:{port}', NODE_ENV: 'test' },
        },
        services: [
          {
            name: 'emulator',
            executable: 'node',
            args: ['emulator.js', '--app-port', '{port}'],
            env: { APP_PORT: '{port}' },
            readyUrl: 'http://127.0.0.1:{port}/emulator/ready',
            teardown: { executable: 'docker', args: ['compose', '-p', 'app-{port}', 'down'] },
          },
        ],
      },
      4321,
    );
    expect(app.command).toEqual({
      executable: 'pnpm',
      args: ['dev', '--port', '4321'],
      env: { PORT: '4321', ORIGIN: 'http://127.0.0.1:4321', NODE_ENV: 'test' },
    });
    expect(app.readyUrl).toBe('http://127.0.0.1:4321/health');
    expect(app.services[0]).toMatchObject({
      command: { executable: 'node', args: ['emulator.js', '--app-port', '4321'], env: { APP_PORT: '4321' } },
      readiness: { readyUrl: 'http://127.0.0.1:4321/emulator/ready' },
      teardown: { command: { executable: 'docker', args: ['compose', '-p', 'app-4321', 'down'] } },
    });
  });

  it('expands {port} to a fixed or default port too', () => {
    const fixed = appOf({ url: 'http://localhost:3000', command: { executable: 'pnpm', env: { PORT: '{port}' } } });
    expect(fixed.command?.env).toEqual({ PORT: '3000' });
    const implied = appOf({ url: 'https://app.test', command: { executable: 'pnpm', args: ['{port}'] } });
    expect(implied.command?.args).toEqual(['443']);
  });

  it('rejects {port} on a target without a URL, naming the field', () => {
    expect(() =>
      appOf({ command: { executable: 'node', args: ['server.js', '{port}'] }, readyUrl: 'http://127.0.0.1:9/' }),
    ).toThrow(/target "web" engine fake app\.command\.args uses \{port\}, but the target declares no url/);
    expect(() => appOf({ services: [{ executable: 'node', env: { PORT: '{port}' }, waitForExit: true }] })).toThrow(
      /app\.services\[0\]\.env\.PORT uses \{port\}/,
    );
    expect(() => appOf({ services: [{ executable: 'node', readyUrl: 'http://127.0.0.1:{port}/' }] })).toThrow(
      /app\.services\[0\]\.readyUrl uses \{port\}/,
    );
  });
});

describe('allocateAppPorts', () => {
  it('reserves a distinct free port per requesting target and leaves the rest alone', async () => {
    const config = configOf({
      a: { url: 'http://127.0.0.1:0', command: { executable: 'pnpm', env: { PORT: '{port}' } } },
      // Only IPv4 loopback is bound here: a CI host without ::1 must not fail this.
      b: { url: 'http://127.0.0.1:0' },
      fixed: { url: 'http://127.0.0.1:3000' },
      none: {},
    });
    const allocated = await allocateAppPorts(config);
    const [a, b, fixed, none] = allocated.targets.map((target) => target.app);
    const portA = a!.portRequest!.port!;
    const portB = b!.portRequest!.port!;
    expect(portA).toBeGreaterThan(0);
    expect(portB).toBeGreaterThan(0);
    expect(portA).not.toBe(portB);
    expect(a!.base?.origin).toBe(`http://127.0.0.1:${portA}`);
    expect(a!.command?.env).toEqual({ PORT: String(portA) });
    expect(b!.base?.origin).toBe(`http://127.0.0.1:${portB}`);
    expect(fixed!.base?.origin).toBe('http://127.0.0.1:3000');
    expect(none!.base).toBeUndefined();
    expect(assignedPorts(allocated)).toEqual({ a: portA, b: portB });
    expect(allocated.configDigest).toBe(config.configDigest);
    // Nothing left to assign: the config passes through untouched.
    expect(await allocateAppPorts(allocated)).toBe(allocated);
    expect(await allocateAppPorts(configOf({ fixed: { url: 'http://127.0.0.1:3000' } }))).toMatchObject({ targets: [{ name: 'fixed' }] });
  });
});
