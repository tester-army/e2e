import { describe, expect, it } from 'vitest';
import { assignPorts, resolveConfig } from '../../src/config/resolve.ts';
import type { ResolvedProcessService } from '../../src/config/services/index.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { resolveNavigationUrl } from '../../src/internal/urls.ts';
import { defineService } from '../../src/services.ts';
import type { ServiceHandle, Target, TargetApp } from '../../src/types.ts';

const ROOT = '/tmp/e2e-services';
const engine = defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, platform: 'web' });

/** One target listing `services`, with an optional app. */
function target(name: string, services: readonly ServiceHandle[], app: TargetApp = {}): Target {
  return { name, engine, app, services };
}

function resolve(targets: readonly Target[]) {
  return resolveConfig({ targets: [...targets] }, { projectRoot: ROOT, env: {} });
}

/** The resolved process service of that name. */
function processOf(config: ReturnType<typeof resolve>, name: string): ResolvedProcessService {
  const service = config.services.get(name);
  if (service?.kind !== 'process') throw new Error(`no process service ${name}`);
  return service;
}

describe('defineService', () => {
  it('returns a frozen handle whose brand a spread copy loses', () => {
    const db = defineService({ name: 'db', executable: 'docker', args: ['compose', 'up', '--wait'], waitForExit: true });
    expect(Object.isFrozen(db)).toBe(true);
    expect(() => resolve([target('web', [{ ...db }])])).toThrow(
      'target "web" services[0] is a copy of service "db"; a spread copy is not the service',
    );
  });

  it('requires a name, and one form: a process or a function', () => {
    expect(() => defineService({ executable: 'x', waitForExit: true } as never)).toThrow('defineService: name is required');
    expect(() => defineService({ name: 'bad name', executable: 'x' })).toThrow('defineService: name is required');
    expect(() => defineService({ name: 'both', executable: 'x', start: async () => {} } as never)).toThrow(
      'service "both" is both a process (executable) and a function (start, stop); a service is one or the other',
    );
    expect(() => defineService({ name: 'none' } as never)).toThrow('service "none" needs executable for a process, or start for a function');
    expect(() => defineService({ name: 'stopper', stop: async () => {} } as never)).toThrow('service "stopper" start must be a function');
    expect(() => defineService({ name: 'typo', executable: 'x', readyURL: 'http://127.0.0.1:1' } as never)).toThrow(
      'service "typo" has unknown key "readyURL"; did you mean "readyUrl"?',
    );
    expect(() => defineService({ name: 'mixed', start: async () => {}, args: [] } as never)).toThrow(
      'args belongs to a process service, and a service is one or the other',
    );
  });

  it('refuses a plain object in dependsOn and bad ports', () => {
    expect(() => defineService({ name: 'web', executable: 'x', waitForExit: true, dependsOn: [{ name: 'db' }] as never })).toThrow(
      'service "web" dependsOn[0] is a plain object; wrap it in defineService',
    );
    expect(() => defineService({ name: 'mail', executable: 'x', waitForExit: true, ports: { SMTP: 0 } })).toThrow('a port name is a lowercase scheme');
    expect(() => defineService({ name: 'mail', executable: 'x', waitForExit: true, ports: { smtp: -1 } })).toThrow(
      'ports.smtp must be 0 for a free port, or a port number',
    );
  });
});

describe('the service graph', () => {
  const db = defineService({ name: 'db', executable: 'docker', args: ['compose', 'up', '--wait'], waitForExit: true, teardown: { executable: 'docker', args: ['compose', 'down'] } });
  const seed = defineService({ name: 'seed', dependsOn: [db], start: async () => {} });
  const stripe = defineService({ name: 'stripe', executable: 'stripe-mock', args: ['-http-port', '{port}'], readyUrl: 'http://127.0.0.1:0' });

  it('pulls in every dependency, orders dependencies first, and keeps each target to its own graph', () => {
    const web = defineService({ name: 'web', executable: 'pnpm', args: ['dev', '--port', '{port}'], env: { STRIPE: stripe.url }, readyUrl: 'http://127.0.0.1:0', dependsOn: [seed, stripe] });
    const config = resolve([target('chromium', [web]), target('ios', [seed]), target('bare', [])]);
    expect([...config.services.keys()]).toEqual(['db', 'seed', 'stripe', 'web']);
    expect(config.targets.map((resolved) => resolved.services)).toEqual([['db', 'seed', 'stripe', 'web'], ['db', 'seed'], []]);
  });

  it('refuses two handles with one name', () => {
    const again = defineService({ name: 'db', executable: 'docker', waitForExit: true });
    expect(() => resolve([target('a', [db]), target('b', [again])])).toThrow(
      'two services are named "db"; a name is one service across the run',
    );
  });

  it('refuses a plain object where a service goes, naming the new shape', () => {
    expect(() => resolve([target('web', [{ name: 'db', executable: 'docker', waitForExit: true } as never])])).toThrow(
      'target "web" services[0] is a plain object; wrap it in defineService({ name, executable, ... }) and list the handle it returns',
    );
    expect(() => resolve([target('web', [{ name: 'api', url: 'http://127.0.0.1:4000', executable: 'node' } as never])])).toThrow(
      'target "web" services[0] is a plain object; wrap it in defineService',
    );
  });
});

describe('ports and placeholders', () => {
  const stripe = defineService({ name: 'stripe', executable: 'stripe-mock', args: ['-http-port', '{port}'], readyUrl: 'http://127.0.0.1:0' });
  const mail = defineService({
    name: 'mail',
    executable: 'mailpit',
    args: ['--smtp', '127.0.0.1:{port:smtp}', '--listen', '127.0.0.1:{port:http}'],
    ports: { smtp: 0, http: 0 },
    readyUrl: 'http://127.0.0.1:{port:http}/livez',
  });
  const web = defineService({
    name: 'web',
    executable: 'pnpm',
    args: ['dev', '--port', '{port}'],
    env: { STRIPE_API_BASE: `${stripe.url}/v1`, SMTP_URL: mail.urlOf('smtp'), SMTP_PORT: mail.portOf('smtp'), STRIPE_PORT: stripe.port },
    readyUrl: 'http://127.0.0.1:0',
    dependsOn: [stripe, mail],
  });
  const ports = { 'service:stripe': 5001, 'service:mail/smtp': 5002, 'service:mail/http': 5003, 'service:web': 5004 };

  it('asks for a free port per port-0 address, and {port} is the process own port', () => {
    const pending = resolve([target('chromium', [web], { url: web.url })]);
    expect(pending.portRequests).toEqual([
      { key: 'service:stripe', host: '127.0.0.1', owner: 'service "stripe"' },
      { key: 'service:mail/smtp', host: '127.0.0.1', owner: 'service "mail"' },
      { key: 'service:mail/http', host: '127.0.0.1', owner: 'service "mail"' },
      { key: 'service:web', host: '127.0.0.1', owner: 'service "web"' },
    ]);
    const assigned = assignPorts(pending, ports);
    expect(processOf(assigned, 'stripe').command.args).toEqual(['-http-port', '5001']);
    expect(processOf(assigned, 'stripe').readiness).toEqual({ readyUrl: 'http://127.0.0.1:5001/' });
    expect(processOf(assigned, 'mail').command.args).toEqual(['--smtp', '127.0.0.1:5002', '--listen', '127.0.0.1:5003']);
    expect(processOf(assigned, 'mail').readiness).toEqual({ readyUrl: 'http://127.0.0.1:5003/livez' });
    expect(processOf(assigned, 'web').command).toMatchObject({
      args: ['dev', '--port', '5004'],
      env: { STRIPE_API_BASE: 'http://127.0.0.1:5001/v1', SMTP_URL: 'smtp://127.0.0.1:5002', SMTP_PORT: '5002', STRIPE_PORT: '5001' },
    });
  });

  it('serves app.url from a service, so two targets share one dev server, and keys the identity on the declared :0', () => {
    const config = assignPorts(
      resolve([
        target('chromium', [web], { url: web.url }),
        { name: 'firefox', engine, app: { url: `${web.url}/admin/` }, services: [web] },
      ]),
      ports,
    );
    expect(config.targets.map((resolved) => resolved.app.base?.href)).toEqual(['http://127.0.0.1:5004/', 'http://127.0.0.1:5004/admin/']);
    expect(config.targets.map((resolved) => resolved.app.identity)).toEqual(['http://127.0.0.1:0/', 'http://127.0.0.1:0/admin/']);
  });

  it('refuses a placeholder for a service outside the graph that reads it', () => {
    expect(() => resolve([target('chromium', [stripe], { url: web.url })])).toThrow(
      'target "chromium" app.url uses the address of service "web", which target "chromium" does not list; add it to the target\'s services',
    );
    const loose = defineService({ name: 'loose', executable: 'x', env: { API: stripe.url }, waitForExit: true });
    expect(() => resolve([target('t', [loose, stripe])])).toThrow(
      'service "loose".env.API uses the address of service "stripe", which service "loose" does not depend on: a service lists it in dependsOn, a target in services',
    );
  });

  it('refuses an address a service does not have', () => {
    const seed = defineService({ name: 'seed', start: async () => {} });
    const migrate = defineService({ name: 'migrate', executable: 'pnpm', args: ['db:migrate'], waitForExit: true });
    const user = defineService({ name: 'user', executable: 'x', args: [seed.url, migrate.url, stripe.urlOf('grpc')], waitForExit: true, dependsOn: [seed, migrate, stripe] });
    expect(() => resolve([target('t', [user])])).toThrow('uses {service:seed.url}, but service "seed" is a function and has no address');
    const second = defineService({ name: 'user', executable: 'x', args: [migrate.url], waitForExit: true, dependsOn: [migrate] });
    expect(() => resolve([target('t', [second])])).toThrow('service "migrate" has no primary address: it comes from its readyUrl');
    const third = defineService({ name: 'user', executable: 'x', args: [stripe.urlOf('grpc')], waitForExit: true, dependsOn: [stripe] });
    expect(() => resolve([target('t', [third])])).toThrow('service "stripe" declares no port "grpc"; declare it in ports');
  });

  it('refuses {port} in a service whose own address asks for no free port', () => {
    const fixed = defineService({ name: 'emulator', executable: 'node', args: ['emulator.js', '--app-port', '{port}'], readyUrl: 'http://127.0.0.1:7000/' });
    expect(() => resolve([target('t', [fixed])])).toThrow(
      'service "emulator".args uses {port}, but service "emulator" has the fixed port 7000: write it directly',
    );
    const implied = defineService({ name: 'web', executable: 'node', env: { PORT: '{port}' }, readyUrl: 'https://api.test/health' });
    expect(() => resolve([target('t', [implied])])).toThrow('service "web".env.PORT uses {port}, but service "web" has the fixed port 443: write it directly');
    const old = defineService({ name: 'emulator', executable: 'node', args: ['emulator.js', '--app-port', '{port}'], waitForExit: true });
    expect(() => resolve([target('t', [old])])).toThrow(
      "service \"emulator\".args uses {port}, but service \"emulator\" asks for no free port: give it one with readyUrl: 'http://127.0.0.1:0'",
    );
    const namedPrimary = defineService({ name: 'mailer', executable: 'x', args: ['{port}'], ports: { http: 0 }, readyUrl: 'http://127.0.0.1:{port:http}/' });
    expect(() => resolve([target('t', [namedPrimary])])).toThrow('service "mailer".args uses {port}, but service "mailer" asks for no free port');
    const unknownPort = defineService({ name: 'mailer', executable: 'x', args: ['{port:smtp}'], waitForExit: true, ports: { http: 0 } });
    expect(() => resolve([target('t', [unknownPort])])).toThrow('uses {port:smtp}, but service "mailer" declares no port "smtp"; its ports are http');
    const inReady = defineService({ name: 'probe', executable: 'x', readyUrl: 'http://127.0.0.1:{port}/' });
    expect(() => resolve([target('t', [inReady])])).toThrow('service "probe".readyUrl uses {port}, but service "probe" has no other address to take the port from');
    const named = defineService({ name: 'appcmd', executable: 'x', waitForExit: true });
    expect(() => resolve([target('t', [named], { url: 'http://127.0.0.1:0', command: { executable: 'x', args: ['{port:http}'] } })])).toThrow(
      'target "t" app.command.args uses {port:http}, but target "t" command declares no port "http"',
    );
  });

  it('refuses reuseExisting on a free port, which can never already answer', () => {
    const fresh = defineService({ name: 'fresh', executable: 'x', readyUrl: 'http://127.0.0.1:0', reuseExisting: true });
    expect(() => resolve([target('t', [fresh])])).toThrow('service "fresh".reuseExisting cannot find service "fresh" already running on a free port');
    const namedFresh = defineService({ name: 'named', executable: 'x', ports: { http: 0 }, readyUrl: 'http://127.0.0.1:{port:http}/', reuseExisting: true });
    expect(() => resolve([target('t', [namedFresh])])).toThrow('reuseExisting cannot find service "named" already running on a free port');
    const freeBesideFixedProbe = defineService({ name: 'mailer', executable: 'x', ports: { smtp: 0 }, readyUrl: 'http://127.0.0.1:7000/', reuseExisting: true });
    expect(() => resolve([target('t', [freeBesideFixedProbe])])).toThrow('service "mailer".reuseExisting cannot find service "mailer" already running on a free port');
    expect(() =>
      resolve([target('t', [], { url: 'http://127.0.0.1:0', readyUrl: 'http://127.0.0.1:3000/health', command: { executable: 'x', reuseExisting: true } })]),
    ).toThrow('target "t" app.command.reuseExisting cannot find target "t" command already running on a free port');
    const fixed =defineService({ name: 'fixed', executable: 'x', readyUrl: 'http://127.0.0.1:7000/', reuseExisting: true });
    expect(() => resolve([target('t', [fixed])])).not.toThrow();
    expect(() => resolve([target('t', [], { url: 'http://127.0.0.1:0', command: { executable: 'x', reuseExisting: true } })])).toThrow(
      'target "t" app.command.reuseExisting cannot find target "t" command already running on a free port',
    );
  });

  it('refuses a free port on anything but a literal loopback address', () => {
    const named = defineService({ name: 'local', executable: 'x', readyUrl: 'http://localhost:0' });
    expect(() => resolve([target('t', [named])])).toThrow('asks for a free port on localhost, which takes only a literal loopback address');
  });

  it('refuses two processes probing one fixed address, pointing at a shared service', () => {
    const command = { executable: 'pnpm', args: ['dev'] };
    expect(() =>
      resolve([
        target('chromium', [], { url: 'http://localhost:3000', command }),
        target('firefox', [], { url: 'http://localhost:3000', command: { executable: 'pnpm', args: ['dev:firefox'] } }),
      ]),
    ).toThrow('target "chromium" command and target "firefox" command both probe http://localhost:3000, so the second would find the first answering; one process several targets share is one service, const app = defineService(');
    const api = defineService({ name: 'api', executable: 'x', readyUrl: 'http://localhost:3000/health' });
    expect(() => resolve([target('t', [api], { url: 'http://localhost:3000', command })])).toThrow(
      'service "api" and target "t" command both probe http://localhost:3000',
    );
    // Each on a free port of its own is two apps.
    const free = { url: 'http://127.0.0.1:0', command: { executable: 'pnpm', args: ['dev', '{port}'] } };
    expect(() => resolve([target('a', [], free), target('b', [], free)])).not.toThrow();
  });

  it("refuses an app.command beside a service's address, and a free port nothing starts on", () => {
    const command = { executable: 'pnpm', args: ['dev'] };
    expect(() => resolve([target('t', [web], { url: web.url, command })])).toThrow(
      'target "t" app.url is the address of service "web", which serves the app, and app.command would start a second process there',
    );
    expect(() => resolve([target('t', [web], { url: 'http://127.0.0.1:0', readyUrl: String(web.url), command })])).toThrow(
      'target "t" app.readyUrl is where target "t" command is probed, its own address, so it cannot be service "web"\'s',
    );
    expect(() => resolve([target('t', [], { url: 'http://127.0.0.1:0' })])).toThrow(
      'target "t" app.url asks for a free port (port 0), but nothing starts on it: add app.command',
    );
  });

  it('names the target, app.url, and the placeholder for an address a target cannot open', () => {
    expect(() => resolve([target('t', [mail], { url: mail.urlOf('smtp') })])).toThrow(
      'target "t" app.url is {service:mail.url:smtp}, service "mail"\'s smtp address, which a target cannot open: app URL must be http(s): {service:mail.url:smtp}',
    );
  });
});

describe('service keys', () => {
  const api = defineService({ name: 'api', executable: 'pnpm', args: ['api', '--port', '{port}'], readyUrl: 'http://127.0.0.1:0' });
  const fixtures = defineService({ name: 'fixtures', dependsOn: [api], start: async () => {} });
  const keys = (ports: Record<string, number>) => {
    const config = assignPorts(
      resolve([target('chromium', [fixtures], { url: 'http://127.0.0.1:0', command: { executable: 'pnpm', args: ['dev', '--port', '{port}'] } })]),
      ports,
    );
    const key = (name: string) => config.services.get(name)!.key;
    return { api: key('api'), fixtures: key('fixtures'), command: key('app:chromium') };
  };

  it('keys a process by how it spawns and by the services it runs against, so a new port or dependency instance is a new process', () => {
    const first = keys({ 'service:app:chromium': 4321, 'service:api': 5000 });
    expect(keys({ 'service:app:chromium': 4321, 'service:api': 5000 })).toEqual(first);
    expect(keys({ 'service:app:chromium': 4322, 'service:api': 5000 }).command).not.toBe(first.command);
    const moved = keys({ 'service:app:chromium': 4321, 'service:api': 5001 });
    expect(moved.api).not.toBe(first.api);
    expect(moved.fixtures).not.toBe(first.fixtures);
    expect(moved.command).not.toBe(first.command);
  });

  it('keys a function service by its name and dependencies, so a reloaded config shares it whatever its hooks say', () => {
    const seedKey = (start: () => Promise<void>) =>
      resolve([target('chromium', [defineService({ name: 'fixture', start })], { url: 'http://localhost:3000' })]).services.get('fixture')!.key;
    expect(seedKey(async () => void 'beta')).toBe(seedKey(async () => {}));
  });
});

describe('a placeholder reaching navigation', () => {
  it('fails naming the service instead of opening a garbled URL', () => {
    const web = defineService({ name: 'web', executable: 'x', readyUrl: 'http://127.0.0.1:0' });
    expect(() => resolveNavigationUrl(String(web.url), undefined)).toThrow(
      'holds the placeholder of service "web", which only the config substitutes',
    );
    expect(() => resolveNavigationUrl(`${web.url}/checkout`, { href: 'http://127.0.0.1:1/', origin: 'http://127.0.0.1:1', basePath: '/' })).toThrow(
      expect.objectContaining({ code: 'INVALID_APP_URL' }),
    );
  });
});
