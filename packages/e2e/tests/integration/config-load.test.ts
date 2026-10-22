/** Loading a config module: a config error it raises while it evaluates keeps its code, any other throw is CONFIG_LOAD_FAILED with the original message, and a symlinked config loads. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The built loader and SDK, as a project's config imports the installed package.
const loaderModule = '../../dist/config/load.js';
const { loadConfigModule } = (await import(loaderModule)) as typeof import('../../src/config/load.ts');
const SDK = new URL('../../dist/index.js', import.meta.url).href;
const ENGINE = new URL('../../dist/engine/index.js', import.meta.url).href;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-config-load-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfigModule', () => {
  it('keeps a refusal from a factory the config calls as INVALID_CONFIG in its own words', async () => {
    writeFileSync(
      path.join(dir, 'e2e.config.ts'),
      `import { defineEngine } from '${ENGINE}';\nexport default { targets: [{ name: 'local', platform: 'test', engine: defineEngine({ name: 'toy', version: '1.0.0', spiVersion: 1, app: { url: 'http://localhost:3000' } } as never) }] };\n`,
    );
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('unknown key "app"'),
    });
  });

  it('suggests satisfies E2EConfig for a missing default export only in a TypeScript config', async () => {
    for (const name of ['e2e.config.ts', 'e2e.config.mjs']) writeFileSync(path.join(dir, name), 'export const targets = [];\n');
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringMatching(/has no default export; write export default \{ targets: \[\.\.\.\] \} satisfies E2EConfig$/),
    });
    await expect(loadConfigModule(path.join(dir, 'e2e.config.mjs'))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringMatching(/has no default export; write export default \{ targets: \[\.\.\.\] \}$/),
    });
  });

  it('keeps INVALID_CONFIG for a secrets.get() reference turned into a string while the config evaluates', async () => {
    writeFileSync(
      path.join(dir, 'e2e.config.ts'),
      `import { secrets } from '${SDK}';\nconst args = [\`--password=\${secrets.get('dbPassword')}\`];\nexport default { targets: [{ name: 'local', platform: 'test', app: { url: 'http://localhost:3000', command: { executable: 'db', args } } }] };\n`,
    );
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('secrets.get("dbPassword") is a reference to a secret, not its value'),
    });
  });

  it('keeps an infrastructure error from another copy of e2e as that, with its code', async () => {
    const foreign = "const error = Object.assign(new Error('no browser'), { category: 'infrastructure', code: 'BROWSER_MISSING', retryable: false });\nerror[Symbol.for('e2e.error.v1')] = true;\nthrow error;\nexport default {};\n";
    writeFileSync(path.join(dir, 'e2e.config.ts'), foreign);
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({ category: 'infrastructure', code: 'BROWSER_MISSING', message: 'no browser' });
  });

  it('preserves the original load error', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), "throw new Error('config setup failed');\n");
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'CONFIG_LOAD_FAILED',
      message: `failed to load config ${path.join(dir, 'e2e.config.ts')}: config setup failed`,
    });
  });

  it('keeps the code of a configuration error the config throws while it evaluates', async () => {
    writeFileSync(
      path.join(dir, 'e2e.config.ts'),
      `import { ConfigurationError } from '${ENGINE}';\nthrow new ConfigurationError('INVALID_CONFIG', 'web({ video }) was renamed web({ screencast })');\n`,
    );
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'web({ video }) was renamed web({ screencast })',
    });
  });

  it('keeps the code of a configuration error from another copy of e2e, and only a configuration one', async () => {
    const foreign = (category: string) =>
      `const error = new Error('refused by a second copy');\nObject.assign(error, { [Symbol.for('e2e.error.v1')]: true, category: '${category}', code: 'INVALID_CONFIG', retryable: false });\nthrow error;\n`;
    writeFileSync(path.join(dir, 'e2e.config.ts'), foreign('configuration'));
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'refused by a second copy',
    });
    writeFileSync(path.join(dir, 'e2e.config.ts'), foreign('test'));
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({ code: 'CONFIG_LOAD_FAILED' });
  });

  it('loads a config through a symlink', async () => {
    const sourceDir = path.join(dir, 'source');
    mkdirSync(sourceDir);
    const source = path.join(sourceDir, 'e2e.config.ts');
    writeFileSync(source, "export default { targets: [{ name: 'local', platform: 'test' }] };\n");
    const linked = path.join(dir, 'e2e.config.ts');
    symlinkSync(source, linked, 'file');
    await expect(loadConfigModule(linked)).resolves.toMatchObject({
      targets: [{ name: 'local', platform: 'test' }],
    });
  });
});
