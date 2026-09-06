import { describe, expect, it } from 'vitest';
import { defineBackend, type BackendAppDeclaration } from '../../src/backend/index.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { declaredProcesses } from '../../src/run/declared-processes.ts';

const ROOT = '/tmp/e2e-declared-processes';

/** Resolves one target per declaration, named t0, t1, ..., the way two browsers on one app would be configured. */
function targets(...declarations: BackendAppDeclaration[]) {
  return resolveConfig(
    {
      targets: declarations.map((app, index) => ({
        name: `t${index}`,
        platform: 'web',
        backend: defineBackend({ name: 'fake', version: '1.0.0', spiVersion: 1, observe: async () => ({ nodes: [] }), app }),
      })),
    },
    { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
  ).targets;
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
      { label: 'target "t0" command', command: dev, readyUrl: 'http://localhost:3000/' },
      { label: 'target "t2" command', command: { executable: 'pnpm', args: ['api'] }, readyUrl: 'http://localhost:4000/' },
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
});
