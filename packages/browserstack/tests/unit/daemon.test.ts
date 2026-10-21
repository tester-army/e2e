/** Against the installed agent-device: the version check and the daemon stop the provider relies on. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { assertDriverVersion, assertSessionsEnded, stopDriver } from '../../src/daemon.ts';

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

const report = (data: unknown) => JSON.stringify({ success: true, data });

it('accepts a shutdown report that ended every BrowserStack session', () => {
  expect(() => assertSessionsEnded(report({ providerReleases: { status: 'completed', released: [{ leaseId: 'l1' }], pending: [] }, warnings: [] }))).not.toThrow();
});

it('refuses a report with sessions still pending', () => {
  expect(() => assertSessionsEnded(report({ providerReleases: { status: 'completed', released: [], pending: [{ leaseId: 'l1' }, { leaseId: 'l2' }] } }))).toThrow('agent-device stopped without ending 2 BrowserStack session(s)');
});

it('refuses a forced stop whose cleanup is unknown, with the daemon\'s warning', () => {
  const forced = report({ mode: 'forced', providerReleases: { status: 'unknown', released: [], pending: null }, warnings: ['The daemon was force-killed before provider lease state could be finalized. Provider allocations may remain active.'] });
  expect(() => assertSessionsEnded(forced)).toThrow('agent-device could not confirm its BrowserStack sessions ended: The daemon was force-killed before provider lease state could be finalized. Provider allocations may remain active.');
});

it('refuses a report without provider releases, and one that is not JSON', () => {
  expect(() => assertSessionsEnded(report({ stopped: true }))).toThrow('agent-device could not confirm its BrowserStack sessions ended');
  expect(() => assertSessionsEnded('killed')).toThrow('agent-device stopped without a readable shutdown report; BrowserStack sessions may still be running');
});
