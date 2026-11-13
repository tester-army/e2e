/** Against the installed agent-device: the version check and the private plugin home a lease's daemon loads a provider plugin from. */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import { agentDevicePlugin } from '../../src/lease/plugin.ts';

const exec = promisify(execFile);
const dir = mkdtempSync(path.join(tmpdir(), 'lease-plugin-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A plugin package whose entry sits below its root, as a built plugin's `dist` does.
const root = path.join(dir, 'cloud');
mkdirSync(path.join(root, 'dist'), { recursive: true });
writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@agent-device/cloud', version: '0.21.37', type: 'module' }));
writeFileSync(path.join(root, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(path.join(root, 'dist', 'index.js'), 'export default {};\n');
const plugin = agentDevicePlugin(pathToFileURL(path.join(root, 'dist', 'index.js')).href);
const cli = fileURLToPath(new URL('../../node_modules/agent-device/bin/agent-device.mjs', import.meta.url));

it("accepts only the plugin version of the engine's agent-device, naming the package from its entry", () => {
  expect(() => plugin.assertVersion('0.21.37')).not.toThrow();
  expect(() => plugin.assertVersion('0.0.1')).toThrow('@agent-device/cloud 0.21.37 is installed, but @e2e-dev/mobile runs agent-device 0.0.1. Install matching versions.');
});

it('registers the installed plugin in a home where agent-device finds it, without the registry', async () => {
  const home = path.join(dir, 'home');
  await plugin.prepareHome(home);
  const { stdout } = await exec(process.execPath, [cli, 'plugins', 'list', '--json'], { env: { PATH: process.env['PATH'], HOME: dir, AGENT_DEVICE_HOME: home } });
  expect(JSON.parse(stdout).data.plugins).toEqual([expect.objectContaining({ name: '@agent-device/cloud', version: '0.21.37' })]);
});
