/** Loading a config module: a config error it raises while it evaluates keeps its code, and any other throw is CONFIG_LOAD_FAILED. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('reports any other throw while the config evaluates as CONFIG_LOAD_FAILED', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), `throw new Error('boom');\nexport default {};\n`);
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({ code: 'CONFIG_LOAD_FAILED' });
  });
});
