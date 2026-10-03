/**
 * Every model gateway `e2e init` offers writes an import line and a model
 * expression into the generated config. Each must name an export that exists
 * at a specifier the project can install, and construct a model the config
 * accepts, or `e2e init` writes a config that fails to load.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GATEWAYS } from '../../src/cli/init/gateways.ts';
import { resolveConfig } from '../../src/config/resolve.ts';

const EXPORTS = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, { default: string }>;
}).exports;

/**
 * The module a scaffold's import specifier loads: a provider package as
 * installed here, or a published `e2e/...` subpath mapped from its dist file
 * back to the source file it is built from.
 */
async function importSpecifier(specifier: string): Promise<Record<string, unknown>> {
  if (!specifier.startsWith('e2e/')) return (await import(specifier)) as Record<string, unknown>;
  const published = EXPORTS[`./${specifier.slice('e2e/'.length)}`];
  expect(published, `package.json exports ${specifier}`).toBeDefined();
  const source = published!.default.replace(/^\.\/dist\//, '../../src/').replace(/\.js$/, '.ts');
  return (await import(source)) as Record<string, unknown>;
}

describe('init gateway scaffolds', () => {
  it.each(GATEWAYS.map((gateway) => [gateway.id, gateway] as const))(
    '%s imports a real export and builds a model the config accepts',
    async (_id, gateway) => {
      const [, binding, specifier] = /^import \{ (\w+) \} from '([^']+)';$/.exec(gateway.import) ?? [];
      expect(binding, gateway.import).toBeDefined();
      const module = await importSpecifier(specifier!);
      expect(typeof module[binding!], `${specifier} exports ${binding}`).toBe('function');
      const model = new Function(binding!, `return ${gateway.model(undefined)};`)(module[binding!]) as object;
      const config = resolveConfig(
        { targets: [{ name: 'web', platform: 'web' }], agents: { default: { model: model as never } } },
        { projectRoot: '/tmp/e2e-init-gateways', env: {} },
      );
      expect(config.agent.model).toMatchObject({ provider: expect.any(String), id: expect.any(String) });
      if (!specifier!.startsWith('e2e/') && specifier !== 'ai') expect(Object.keys(gateway.dependencies)).toContain(specifier);
    },
  );
});
