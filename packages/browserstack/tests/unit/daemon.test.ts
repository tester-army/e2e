/** Against the installed agent-device: the version check and the daemon stop the provider relies on. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { assertDriverVersion, stopDriver } from '../../src/daemon.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'browserstack-daemon-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const root = path.join(path.dirname(fileURLToPath(import.meta.resolve('agent-device'))), '..', '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };

it('accepts only the agent-device version the engine uses', () => {
  expect(() => assertDriverVersion(version)).not.toThrow();
  expect(() => assertDriverVersion('0.0.1')).toThrow(`@e2e-dev/browserstack uses agent-device ${version}, but @e2e-dev/mobile uses 0.0.1. Install matching versions.`);
});


it('stops a daemon that is not running without error', async () => {
  await expect(stopDriver(path.join(dir, 'state'), { PATH: process.env['PATH'], HOME: dir }, AbortSignal.timeout(30_000))).resolves.toBeUndefined();
});
