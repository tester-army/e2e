/** Against the installed agent-device: the daemon stop a lease's release relies on, and the report it checks. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { assertSessionsEnded, stopDriver } from '../../src/lease/daemon.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'lease-daemon-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('stops a daemon that is not running without error before a lease was granted', async () => {
  await expect(stopDriver(path.join(dir, 'state'), { PATH: process.env['PATH'], HOME: dir }, undefined, 'BrowserStack', AbortSignal.timeout(30_000))).resolves.toBeUndefined();
});

it('refuses to confirm a granted lease ended when no daemon is running to release it', async () => {
  await expect(stopDriver(path.join(dir, 'state'), { PATH: process.env['PATH'], HOME: dir }, 'lease-1', 'BrowserStack', AbortSignal.timeout(30_000))).rejects.toThrow(
    'agent-device found no daemon running for lease lease-1, so nothing confirms its BrowserStack session ended',
  );
});

const report = (data: unknown) => JSON.stringify({ success: true, data });
const graceful = (released: unknown[], pending: unknown[] = []) => report({ stopped: true, mode: 'graceful', providerReleases: { status: 'completed', released, pending }, warnings: [] });
const notRunning = report({ stopped: false, mode: 'not-running', providerReleases: { status: 'completed', released: [], pending: [] }, warnings: [] });

it('accepts a graceful stop that released the lease, and any graceful stop before a grant', () => {
  expect(() => assertSessionsEnded(graceful([{ leaseId: 'l1', provider: 'browserstack' }]), 'l1', 'BrowserStack')).not.toThrow();
  expect(() => assertSessionsEnded(graceful([]), undefined, 'BrowserStack')).not.toThrow();
});

it('accepts no running daemon only before a lease was granted', () => {
  expect(() => assertSessionsEnded(notRunning, undefined, 'BrowserStack')).not.toThrow();
  expect(() => assertSessionsEnded(notRunning, 'l1', 'BrowserStack')).toThrow('agent-device found no daemon running for lease l1, so nothing confirms its BrowserStack session ended');
});

it('refuses a graceful stop that did not release the granted lease, as from a daemon started after the granting one died', () => {
  expect(() => assertSessionsEnded(graceful([{ leaseId: 'l2', provider: 'browserstack' }]), 'l1', 'BrowserStack')).toThrow(
    'agent-device stopped without listing lease l1 as released, so nothing confirms its BrowserStack session ended',
  );
});

it('refuses a report with sessions still pending', () => {
  expect(() => assertSessionsEnded(graceful([], [{ leaseId: 'l1' }, { leaseId: 'l2' }]), undefined, 'BrowserStack')).toThrow('agent-device stopped without ending 2 BrowserStack session(s)');
});

it('refuses a forced stop whose cleanup is unknown, with the daemon\'s warning', () => {
  const forced = report({ stopped: true, mode: 'forced', providerReleases: { status: 'unknown', released: [], pending: null }, warnings: ['The daemon was force-killed before provider lease state could be finalized. Provider allocations may remain active.'] });
  expect(() => assertSessionsEnded(forced, 'l1', 'BrowserStack')).toThrow('agent-device could not confirm its BrowserStack sessions ended: The daemon was force-killed before provider lease state could be finalized. Provider allocations may remain active.');
});

it('refuses a report without provider releases, and one that is not JSON', () => {
  expect(() => assertSessionsEnded(report({ stopped: true }), undefined, 'BrowserStack')).toThrow('agent-device could not confirm its BrowserStack sessions ended');
  expect(() => assertSessionsEnded('killed', undefined, 'BrowserStack')).toThrow('agent-device stopped without a readable shutdown report; BrowserStack sessions may still be running');
});
