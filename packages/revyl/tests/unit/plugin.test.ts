/** Against the installed agent-device and plugin: the plugin home a lease's daemon loads `@agent-device/revyl` from. */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { agentDevicePlugin } from '@e2e-dev/mobile/lease';
import { afterAll, expect, it } from 'vitest';

const exec = promisify(execFile);
const dir = mkdtempSync(path.join(tmpdir(), 'revyl-plugin-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The agent-device that runs the daemons is `@e2e-dev/mobile`'s.
const cli = fileURLToPath(new URL('../../../mobile/node_modules/agent-device/bin/agent-device.mjs', import.meta.url));

it('registers the installed plugin in a home agent-device lists as compatible, without the registry', async () => {
  const home = path.join(dir, 'home');
  await agentDevicePlugin(import.meta.resolve('@agent-device/revyl')).prepareHome(home);
  const { stdout } = await exec(process.execPath, [cli, 'plugins', 'list', '--json'], { env: { PATH: process.env['PATH'], HOME: dir, AGENT_DEVICE_HOME: home } });
  expect(JSON.parse(stdout).data.plugins).toEqual([expect.objectContaining({ name: '@agent-device/revyl', provider: 'revyl', compatible: true })]);
});
