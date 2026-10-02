/** Loading a config module: a config error it raises while it evaluates keeps its code, and any other throw is CONFIG_LOAD_FAILED. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The built loader and SDK, as a project's config imports the installed package.
const loaderModule = '../../dist/config/load.js';
const { loadConfigModule } = (await import(loaderModule)) as typeof import('../../src/config/load.ts');
const SDK = new URL('../../dist/index.js', import.meta.url).href;

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
      `import { defineService } from '${SDK}';\nexport default { targets: [{ name: 'local', platform: 'test', services: [defineService({ name: 'db' } as never)] }] };\n`,
    );
    await expect(loadConfigModule(path.join(dir, 'e2e.config.ts'))).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: 'defineService: service "db" needs executable for a process, or start for a function',
    });
  });

  it('keeps INVALID_CONFIG for a secrets.get() reference turned into a string while the config evaluates', async () => {
    writeFileSync(
      path.join(dir, 'e2e.config.ts'),
      `import { defineService, secrets } from '${SDK}';\nconst db = defineService({ name: 'db', executable: 'db', args: [\`--password=\${secrets.get('dbPassword')}\`], waitForExit: true });\nexport default { targets: [{ name: 'local', platform: 'test', services: [db] }] };\n`,
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
