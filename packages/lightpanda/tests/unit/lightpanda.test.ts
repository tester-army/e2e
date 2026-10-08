/**
 * `lightpanda()` against a fake binary: a node script that parses the serve
 * flags, listens on the port, and answers `/json/version`. Covers the lease
 * endpoint and log line, the flags passed, stop on release, where the binary
 * is found, a binary that exits before listening or never answers, and a
 * cancelled request.
 */

import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserLease, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lightpanda } from '../../src/index.ts';

const FAKE_SERVER = `
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
if (args[0] !== 'serve') { process.stderr.write('usage: lightpanda serve'); process.exit(2); }
if (args.includes('--crash')) { process.stderr.write('boom: bad flag'); process.exit(1); }
const delay = Number(flag('--delay') ?? 0);
const http = require('node:http');
setTimeout(() => {
  http.createServer((request, response) => {
    if (request.url === '/json/version') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ Browser: 'Lightpanda/1.0', 'Lightpanda-Version': '1.1.0-test', args }));
      return;
    }
    response.statusCode = 404;
    response.end();
  }).listen(Number(flag('--port')), flag('--host'));
}, delay);
process.on('SIGTERM', () => process.exit(0));
`;

let dir: string;
let binary: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'e2e-lightpanda-'));
  const script = path.join(dir, 'fake-lightpanda.cjs');
  writeFileSync(script, FAKE_SERVER);
  binary = path.join(dir, 'lightpanda');
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(binary, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function request(overrides: Partial<BrowserRequest> = {}): BrowserRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    runId: 'run-1',
    targetName: 'web',
    slot: 0,
    slots: 1,
    env: {},
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

const releaseContext: BrowserReleaseContext = {
  runId: 'run-1',
  targetName: 'web',
  env: {},
  signal: new AbortController().signal,
  log: () => undefined,
};

/** The flags the fake server behind `lease` was started with, read back through `/json/version`; undefined once it is gone. */
async function serverArgs(lease: BrowserLease): Promise<string[] | undefined> {
  try {
    const response = await fetch(lease.cdpEndpoint.replace('ws://', 'http://') + 'json/version');
    return ((await response.json()) as { args: string[] }).args;
  } catch {
    return undefined;
  }
}

/** How many fake servers are running right now, whatever port they took. */
function runningFakes(): number {
  try {
    return execSync('pgrep -f fake-lightpanda.cjs', { encoding: 'utf8' }).trim().split('\n').length;
  } catch {
    return 0;
  }
}

describe('lightpanda()', () => {
  it('starts a server on a free loopback port, logs it, and stops it on release', async () => {
    const provider = lightpanda({ binary });
    const req = request();
    const lease = await provider.acquire(req);
    expect(lease.cdpEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/$/);
    expect(lease.id).toBe(lease.cdpEndpoint);
    expect(req.lines).toEqual([`lightpanda 1.1.0-test at ${lease.cdpEndpoint}`]);
    expect(await serverArgs(lease)).toEqual(['serve', '--host', '127.0.0.1', '--port', new URL(lease.cdpEndpoint).port]);
    await provider.release(lease, releaseContext);
    expect(await serverArgs(lease)).toBeUndefined();
  });

  it('passes load-resources and extra flags, and gives each slot its own server', async () => {
    const provider = lightpanda({ binary, loadResources: ['iframe', 'stylesheet'], args: ['--log-level', 'warn'] });
    const [a, b] = await Promise.all([provider.acquire(request({ slot: 0, slots: 2 })), provider.acquire(request({ slot: 1, slots: 2 }))]);
    expect(a.cdpEndpoint).not.toBe(b.cdpEndpoint);
    expect((await serverArgs(a))?.slice(5)).toEqual(['--load-resources', 'iframe', '--load-resources', 'stylesheet', '--log-level', 'warn']);
    await Promise.all([provider.release(a, releaseContext), provider.release(b, releaseContext)]);
  });

  it('reads the binary from LIGHTPANDA_PATH in the run environment', async () => {
    const provider = lightpanda();
    const lease = await provider.acquire(request({ env: { LIGHTPANDA_PATH: binary } }));
    expect(await serverArgs(lease)).toBeDefined();
    await provider.release(lease, releaseContext);
  });

  it('finds the binary on PATH, then under the home directory, and names the install page otherwise', async () => {
    const home = path.join(dir, 'home');
    mkdirSync(path.join(home, '.lightpanda'), { recursive: true });
    copyFileSync(binary, path.join(home, '.lightpanda', 'lightpanda'));
    const provider = lightpanda();
    const fromHome = await provider.acquire(request({ env: { HOME: home, PATH: path.join(dir, 'empty') } }));
    expect(await serverArgs(fromHome)).toBeDefined();
    await provider.release(fromHome, releaseContext);

    const fromPath = await provider.acquire(request({ env: { HOME: path.join(dir, 'nohome'), PATH: dir } }));
    expect(await serverArgs(fromPath)).toBeDefined();
    await provider.release(fromPath, releaseContext);

    await expect(provider.acquire(request({ env: { HOME: path.join(dir, 'nohome'), PATH: path.join(dir, 'empty') } }))).rejects.toThrow(
      /not on PATH, in ~\/.lightpanda, or in ~\/.local\/bin; install it \(https:\/\/lightpanda.io\/docs\/open-source\/installation\) or set LIGHTPANDA_PATH/,
    );
  });

  it('fails with the stderr of a binary that exits before listening', async () => {
    const provider = lightpanda({ binary, args: ['--crash'] });
    await expect(provider.acquire(request())).rejects.toThrow(/exited with code 1 before its CDP server answered:\nboom: bad flag/);
  });

  it('fails when the binary is missing', async () => {
    const provider = lightpanda({ binary: path.join(dir, 'nope') });
    await expect(provider.acquire(request())).rejects.toThrow(/could not start .*nope/);
  });

  it('stops a server that is still starting when the request is cancelled', async () => {
    const controller = new AbortController();
    const provider = lightpanda({ binary, args: ['--delay', '300'] });
    const pending = provider.acquire(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow(/cancelled before the CDP server answered/);
    expect(runningFakes()).toBe(0);
  });

  it('stops a server that never answers once the startup timeout passes', async () => {
    const provider = lightpanda({ binary, args: ['--delay', '60000'] });
    await expect(provider.acquire(request())).rejects.toThrow(/did not answer on http:\/\/127\.0\.0\.1:\d+\/json\/version within 10000ms/);
    expect(runningFakes()).toBe(0);
  }, 20_000);
});
