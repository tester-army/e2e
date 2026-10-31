/** Against the installed agent-device and plugin: the version check and the private plugin home a daemon loads the plugin from. */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import { assertPluginVersion, installPlugin } from '../../src/daemon.ts';

const exec = promisify(execFile);
const dir = mkdtempSync(path.join(tmpdir(), 'testmu-daemon-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const plugin = path.join(path.dirname(fileURLToPath(import.meta.resolve('@agent-device/testmu'))), '..');
const { version } = JSON.parse(readFileSync(path.join(plugin, 'package.json'), 'utf8')) as { version: string };
// The agent-device that runs the daemons is `@e2e-dev/mobile`'s.
const cli = fileURLToPath(new URL('../../../mobile/node_modules/agent-device/bin/agent-device.mjs', import.meta.url));

it('accepts only a plugin of the agent-device version the engine uses', () => {
  expect(() => assertPluginVersion(version)).not.toThrow();
  expect(() => assertPluginVersion('0.0.1')).toThrow(`@e2e-dev/testmu uses @agent-device/testmu ${version}, but @e2e-dev/mobile uses agent-device 0.0.1. Install matching versions.`);
});

it('registers the installed plugin in a home agent-device lists as compatible, without the registry', async () => {
  const home = path.join(dir, 'home');
  await installPlugin(home);
  const { stdout } = await exec(process.execPath, [cli, 'plugins', 'list', '--json'], { env: { PATH: process.env['PATH'], HOME: dir, AGENT_DEVICE_HOME: home } });
  expect(JSON.parse(stdout).data.plugins).toEqual([expect.objectContaining({ name: '@agent-device/testmu', provider: 'testmu', compatible: true })]);
});
