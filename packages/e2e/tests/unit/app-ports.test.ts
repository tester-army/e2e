import { describe, expect, it } from 'vitest';
import { assignPorts, resolveConfig, type PortAssignments, type ResolvedConfig } from '../../src/config/resolve.ts';
import type { ResolvedProcessService } from '../../src/config/services/index.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { defineService } from '../../src/services.ts';
import type { Target, TargetApp } from '../../src/types.ts';
import { allocateAppPorts } from '../../src/run/app-ports.ts';
import { snapshot } from '../helpers/snapshot.ts';

/** A target's `app` with the `services` it needs beside it, as one literal. */
type Declared = TargetApp & { readonly services?: Target['services'] };

/** The target keys one declaration becomes. */
function split({ services, ...app }: Declared): Pick<Target, 'app' | 'services'> {
  return { app, ...(services === undefined ? {} : { services }) };
}

const ROOT = '/tmp/e2e-app-ports';

/** Resolves one web target per declaration, named after its key, then assigns `ports`. */
function configOf(apps: Readonly<Record<string, Declared>>, ports: PortAssignments = {}) {
  const config = resolveConfig(
    {
      targets: Object.entries(apps).map(([name, app]) => ({
        name,
        platform: 'web',
        engine: defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]) }),
        ...split(app),
      })),
    },
    { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
  );
  return assignPorts(config, ports);
}

/** The process a target's `app.command` is. */
function commandOf(config: ResolvedConfig, target = 'web'): ResolvedProcessService {
  const service = config.services.get(`app:${target}`);
  if (service?.kind !== 'process') throw new Error(`target ${target} has no app.command`);
  return service;
}

/** One target named web, with its command's free port assigned `port`. */
function webOf(app: Declared, port?: number) {
  return configOf({ web: app }, port === undefined ? {} : { 'service:app:web': port });
}

describe('an app command on a free port', () => {
  it('keeps the declared :0 URL and asks for a port until one is assigned', () => {
    const config = webOf({ url: 'http://127.0.0.1:0', command: { executable: 'pnpm', args: ['dev'] } });
    const app = config.targets[0]!.app;
    expect(app.base?.href).toBe('http://127.0.0.1:0/');
    expect(config.portRequests).toEqual([{ key: 'service:app:web', host: '127.0.0.1', owner: 'target "web" command' }]);
    expect(app.site).toBe('127.0.0.1');
    expect(commandOf(config).readiness).toEqual({ readyUrl: 'http://127.0.0.1:0/' });
    expect(app.identity).toBe('http://127.0.0.1:0/');
    expect(webOf({ url: 'http://localhost:3000' }).portRequests).toEqual([]);
    expect(webOf({}).portRequests).toEqual([]);
  });

  it('substitutes the assigned port in the base URL and the default readyUrl, keeping the identity', () => {
    const declaration: Declared = { url: 'http://127.0.0.1:0/shop/', command: { executable: 'pnpm', args: ['dev'] } };
    const pending = webOf(declaration);
    const assigned = assignPorts(pending, { 'service:app:web': 4321 });
    const app = assigned.targets[0]!.app;
    expect(app.base).toEqual({ href: 'http://127.0.0.1:4321/shop/', origin: 'http://127.0.0.1:4321', basePath: '/shop/' });
    expect(commandOf(assigned).readiness).toEqual({ readyUrl: 'http://127.0.0.1:4321/shop/' });
    expect(app.identity).toBe(pending.targets[0]!.app.identity);
    expect(app.identity).toBe('http://127.0.0.1:0/shop/');
    expect(assigned.configDigest).toBe(pending.configDigest);
    // A target that named its port ignores an assignment.
    expect(webOf({ url: 'http://localhost:3000' }, 4321).targets[0]!.app.base?.origin).toBe('http://localhost:3000');
  });

  it('expands {port} in the command and its readiness URL to the app port', () => {
    const config = webOf(
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
    );
    expect(commandOf(config).command).toEqual({
      executable: 'pnpm',
      args: ['dev', '--port', '4321'],
      env: { PORT: '4321', ORIGIN: 'http://127.0.0.1:4321', NODE_ENV: 'test' },
    });
    expect(commandOf(config).readiness).toEqual({ readyUrl: 'http://127.0.0.1:4321/health' });
  });

  it('expands {port} to the fixed or default port of app.url, and refuses it without one', () => {
    expect(commandOf(webOf({ url: 'http://localhost:3000', command: { executable: 'pnpm', env: { PORT: '{port}' } } })).command.env).toEqual({ PORT: '3000' });
    expect(commandOf(webOf({ url: 'https://app.test', command: { executable: 'pnpm', args: ['{port}'] } })).command.args).toEqual(['443']);
    expect(() => webOf({ command: { executable: 'npx', args: ['expo', 'start', '--port', '{port}'] }, readyUrl: 'http://127.0.0.1:8081/status' })).toThrow(
      'target "web" app.command.args uses {port}, but target "web" command has the fixed port 8081: write it directly',
    );
    expect(() => webOf({ command: { executable: 'node' }, readyUrl: 'http://127.0.0.1:{port}/' })).toThrow(
      'target "web" app.readyUrl uses {port}, but target "web" command has no other address to take the port from',
    );
  });
});

describe('allocateAppPorts', () => {
  it('reserves a distinct free port per request and leaves the rest alone', async () => {
    const config = configOf({
      a: { url: 'http://127.0.0.1:0', command: { executable: 'pnpm', env: { PORT: '{port}' } } },
      // Only IPv4 loopback is bound here: a CI host without ::1 must not fail this.
      b: { url: 'http://127.0.0.1:0', command: { executable: 'pnpm', args: ['b'] } },
      fixed: { url: 'http://127.0.0.1:3000' },
      none: {},
    });
    const allocated = await allocateAppPorts(config);
    const [a, b, fixed, none] = allocated.targets.map((target) => target.app);
    const portA = allocated.ports['service:app:a']!;
    const portB = allocated.ports['service:app:b']!;
    expect(portA).toBeGreaterThan(0);
    expect(portB).toBeGreaterThan(0);
    expect(portA).not.toBe(portB);
    expect(a!.base?.origin).toBe(`http://127.0.0.1:${portA}`);
    expect(commandOf(allocated, 'a').command.env).toEqual({ PORT: String(portA) });
    expect(b!.base?.origin).toBe(`http://127.0.0.1:${portB}`);
    expect(fixed!.base?.origin).toBe('http://127.0.0.1:3000');
    expect(none!.base).toBeUndefined();
    expect(allocated.configDigest).toBe(config.configDigest);
    // Nothing left to assign: the config passes through untouched.
    expect(await allocateAppPorts(allocated)).toBe(allocated);
  });

  it("reserves every service's free ports too, keyed for the worker bootstrap", async () => {
    const mail = defineService({ name: 'mail', executable: 'mailpit', ports: { smtp: 0 }, readyUrl: 'http://127.0.0.1:0/livez' });
    const web = defineService({ name: 'web', executable: 'pnpm', args: ['dev', '{port}'], env: { SMTP: mail.urlOf('smtp') }, readyUrl: 'http://127.0.0.1:0', dependsOn: [mail] });
    const declared = { shop: { url: web.url, services: [web] }, admin: { url: 'http://127.0.0.1:0', command: { executable: 'pnpm', args: ['admin'] } } };
    const allocated = await allocateAppPorts(configOf(declared));
    const { ports } = allocated;
    expect(Object.keys(ports).toSorted()).toEqual(['service:app:admin', 'service:mail', 'service:mail/smtp', 'service:web']);
    expect(new Set(Object.values(ports)).size).toBe(4);
    expect(allocated.targets[0]!.app.base?.origin).toBe(`http://127.0.0.1:${ports['service:web']}`);
    const served = allocated.services.get('web');
    expect(served?.kind === 'process' ? served.command.env : undefined).toEqual({ SMTP: `smtp://127.0.0.1:${ports['service:mail/smtp']}` });
    // A worker handed the same ports resolves the same services and URLs.
    const worker = configOf(declared, ports);
    expect(worker.services).toEqual(allocated.services);
    expect(worker.targets.map((target) => target.app)).toEqual(allocated.targets.map((target) => target.app));
  });
});
