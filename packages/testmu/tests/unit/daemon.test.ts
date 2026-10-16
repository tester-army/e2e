/** Against the installed agent-device and plugin: the private plugin home and the daemon stop the provider relies on. */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import { assertDriverVersion, installPlugin, stopDriver } from '../../src/daemon.ts';

const exec = promisify(execFile);
const dir = mkdtempSync(path.join(tmpdir(), 'testmu-daemon-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const root = path.join(path.dirname(fileURLToPath(import.meta.resolve('agent-device'))), '..', '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const cli = path.join(root, 'bin', 'agent-device.mjs');

it('accepts only the agent-device version the engine uses', () => {
  expect(() => assertDriverVersion(version)).not.toThrow();
  expect(() => assertDriverVersion('0.0.1')).toThrow(`@e2e-dev/testmu uses agent-device ${version}, but @e2e-dev/mobile uses 0.0.1. Install matching versions.`);
});

it('registers the installed plugin in a home agent-device lists as compatible, without the registry', async () => {
  const home = path.join(dir, 'home');
  await installPlugin(home);
  const { stdout } = await exec(process.execPath, [cli, 'plugins', 'list', '--json'], { env: { PATH: process.env['PATH'], HOME: dir, AGENT_DEVICE_HOME: home } });
  expect(JSON.parse(stdout).data.plugins).toEqual([expect.objectContaining({ name: '@agent-device/testmu', provider: 'testmu', compatible: true })]);
});

it('stops a daemon that is not running without error', async () => {
  await expect(stopDriver(path.join(dir, 'state'), { PATH: process.env['PATH'], HOME: dir }, AbortSignal.timeout(30_000))).resolves.toBeUndefined();
});
