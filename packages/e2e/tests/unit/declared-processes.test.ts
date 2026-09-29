import { describe, expect, it } from 'vitest';
import { defineEngine, type EngineAppDeclaration } from '../../src/engine/index.ts';
import { assignPorts, resolveConfig } from '../../src/config/resolve.ts';
import { declaredProcesses } from '../../src/run/declared-processes.ts';
import { snapshot } from '../helpers/snapshot.ts';

const ROOT = '/tmp/e2e-declared-processes';

/** Resolves one target per declaration, named t0, t1, ..., the way two browsers on one app would be configured. */
function configOf(...declarations: EngineAppDeclaration[]) {
  return resolveConfig(
    {
      targets: declarations.map((app, index) => ({
        name: `t${index}`,
        platform: 'web',
        engine: defineEngine({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => snapshot([]), app }),
      })),
    },
    { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
  );
}

function targets(...declarations: EngineAppDeclaration[]) {
  return configOf(...declarations).targets;
}

const postgres = { name: 'postgres', executable: 'docker', args: ['compose', 'up', '--wait', 'postgres'], waitForExit: true };
const redis = { name: 'redis', executable: 'docker', args: ['compose', 'up', '--wait', 'redis'], waitForExit: true };
const dev = { executable: 'pnpm', args: ['dev'] };

describe('declaredProcesses', () => {
  it('starts identical services and commands once, in target order, probing the first readyUrl', () => {
    const { services, commands } = declaredProcesses(
      targets(
        { url: 'http://localhost:3000', command: dev, services: [postgres, redis] },
        { url: 'http://localhost:3000/admin', command: dev, services: [postgres, redis] },
        { url: 'http://localhost:4000', command: { executable: 'pnpm', args: ['api'] } },
      ),
    );
    expect(services.map((service) => service.label)).toEqual(['service "postgres"', 'service "redis"']);
    expect(commands).toEqual([
      { label: 'target "t0" command', command: dev, readyUrl: 'http://localhost:3000/', key: expect.any(String) },
      { label: 'target "t2" command', command: { executable: 'pnpm', args: ['api'] }, readyUrl: 'http://localhost:4000/', key: expect.any(String) },
    ]);
  });

  it('merges partially overlapping declarations in a consistent order and rejects conflicting ones', () => {
    const merged = declaredProcesses(targets({ services: [postgres] }, { services: [postgres, redis] }));
    expect(merged.services.map((service) => service.label)).toEqual(['service "postgres"', 'service "redis"']);
    expect(() => declaredProcesses(targets({ services: [postgres, redis] }, { services: [redis, postgres] }))).toThrow(
      /target "t1" declares service "postgres" after service "redis", but target "t0" declares them the other way round/,
    );
  });

  it('rejects one explicit name on two different services, and lets the same service repeat under it', () => {
    expect(() =>
      declaredProcesses(targets({ services: [postgres] }, { services: [{ ...postgres, args: ['compose', 'up', 'pg16'] }] })),
    ).toThrow(/service "postgres" is declared by target "t1" and by target "t0" with different commands/);
    expect(declaredProcesses(targets({ services: [postgres] }, { services: [postgres] })).services).toHaveLength(1);
    // Derived names may repeat: they describe the executable, not one process.
    const derived = declaredProcesses(
      targets({ services: [{ executable: 'pnpm', args: ['db:migrate'], waitForExit: true }] }, {
        services: [{ executable: 'pnpm', args: ['db:seed'], waitForExit: true }],
      }),
    );
    expect(derived.services.map((service) => service.label)).toEqual(['service "pnpm"', 'service "pnpm"']);
  });

  it('dedupes commands and services on their expanded values once ports are assigned', () => {
    const emulator = { executable: 'node', args: ['emulator.js', '{port}'], waitForExit: true };
    const shared: EngineAppDeclaration = {
      url: 'http://127.0.0.1:0',
      command: { executable: 'pnpm', args: ['dev', '--port', '{port}'], env: { PORT: '{port}' } },
      services: [emulator],
    };
    const onePort = declaredProcesses(assignPorts(configOf(shared, shared), { t0: 4321, t1: 4321 }).targets);
    expect(onePort.commands).toEqual([
      {
        label: 'target "t0" command',
        command: { executable: 'pnpm', args: ['dev', '--port', '4321'], env: { PORT: '4321' } },
        readyUrl: 'http://127.0.0.1:4321/',
        key: expect.any(String),
      },
    ]);
    expect(onePort.services.map((service) => service.command.args)).toEqual([['emulator.js', '4321']]);
    // Two ports are two servers, each probed where it listens, with a service each.
    const twoPorts = declaredProcesses(assignPorts(configOf(shared, shared), { t0: 4321, t1: 4322 }).targets);
    expect(twoPorts.commands.map((command) => command.readyUrl)).toEqual(['http://127.0.0.1:4321/', 'http://127.0.0.1:4322/']);
    expect(twoPorts.services.map((service) => service.command.args)).toEqual([['emulator.js', '4321'], ['emulator.js', '4322']]);
    // An explicit name still means one process: expanded to two ports it names two.
    const named: EngineAppDeclaration = { ...shared, services: [{ ...emulator, name: 'emulator' }] };
    expect(() => declaredProcesses(assignPorts(configOf(named, named), { t0: 4321, t1: 4322 }).targets)).toThrow(
      /service "emulator" is declared by target "t1" and by target "t0" with different commands/,
    );
  });
});

describe('process keys', () => {
  it('gives a command whose port 0 was allocated per run a key of its own', () => {
    const declaration = { url: 'http://127.0.0.1:0', command: { executable: 'pnpm', args: ['dev', '--port', '{port}'] } };
    const [first] = declaredProcesses(assignPorts(configOf(declaration), { t0: 4321 }).targets).commands;
    const [again] = declaredProcesses(assignPorts(configOf(declaration), { t0: 4321 }).targets).commands;
    const [second] = declaredProcesses(assignPorts(configOf(declaration), { t0: 4322 }).targets).commands;
    expect(first!.key).toBe(again!.key);
    expect(first!.key).not.toBe(second!.key);
  });

  it('names a service by how it spawns and settles, whatever it is called', () => {
    const key = (service: typeof postgres) => declaredProcesses(targets({ url: 'http://127.0.0.1:3000', services: [service] })).services[0]!.key;
    expect(key(postgres)).toBe(key({ ...postgres, name: 'db' }));
    expect(key(postgres)).not.toBe(key(redis));
  });
});
