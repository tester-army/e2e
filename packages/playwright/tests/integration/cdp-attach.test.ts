/**
 * The CDP-attach seam end to end: a real Chrome is launched out-of-band with
 * remote debugging, the engine attaches to it through `connect.cdpEndpoint`
 * instead of launching its own, drives a full attempt over that connection,
 * and on dispose detaches without killing the remote the host owns. This is
 * the exact shape a hosted-browser engine (a per-run cloud session) uses.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineHandle, OperationContext } from '@e2edev/e2e/engine';
import { playwright } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(attemptId: string): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-cdp', attemptId };
}

/** A live Chrome with a random remote-debugging port; the host the engine attaches to. */
interface RemoteChrome {
  readonly endpoint: string;
  readonly proc: ChildProcess;
  readonly userDataDir: string;
  readonly closed: Promise<void>;
}

/** Waits for Chrome and its stdio to close before removing the profile it writes. */
async function closeRemoteChrome(chrome: Omit<RemoteChrome, 'endpoint'>): Promise<void> {
  if (chrome.proc.exitCode === null && chrome.proc.signalCode === null) chrome.proc.kill('SIGKILL');
  await chrome.closed;
  rmSync(chrome.userDataDir, { recursive: true, force: true });
}

/** Launches the remote host and releases its resources if it never becomes ready. */
async function launchRemoteChrome(): Promise<RemoteChrome> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'e2e-cdp-host-'));
  // The sandbox flags are what a containerized CI runner needs to start Chrome
  // at all; they change nothing about the attach under test.
  const proc = spawn(chromium.executablePath(), [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Match Playwright's extension defaults: this blank host needs no extension workers.
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ]);
  const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()));
  const remote = { proc, userDataDir, closed };
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome never printed a CDP endpoint')), 30_000);
    let buffered = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    proc.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      // Surface Chrome's own stderr: it names the missing flag or library.
      reject(
        new Error(
          `Chrome exited before it was ready (code ${code}, signal ${signal}):\n${buffered.trim()}`,
        ),
      );
    });
  });
  try {
    const endpoint = await ready;
    return { endpoint, ...remote };
  } catch (cause) {
    await closeRemoteChrome(remote);
    throw cause;
  }
}

describe('playwright engine over CDP', () => {
  let app: FixtureApp;
  let chrome: RemoteChrome;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    chrome = await launchRemoteChrome();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-cdp-artifacts-'));
  }, 60_000);

  afterAll(async () => {
    // beforeAll may have failed part-way; tear down only what exists.
    await app?.close();
    if (chrome !== undefined) await closeRemoteChrome(chrome);
    if (artifactsDir !== undefined) rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('attaches to the remote, drives an attempt, and detaches on dispose without killing it', async () => {
    let resolved = 0;
    const engine: EngineHandle = playwright({
      connect: {
        cdpEndpoint: () => {
          resolved += 1;
          return chrome.endpoint;
        },
      },
    });

    await engine.init!({
      runId: 'run-cdp',
      targetName: 'web',
      projectRoot: process.cwd(),
      app: { baseUrl: app.url, allowedOrigins: [new URL(app.url).origin] },
      testIdAttribute: 'data-testid',
      headed: false,
      signal: new AbortController().signal,
    });
    expect(resolved).toBe(1);

    try {
      await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal });
      await engine.app!.navigate!(`${app.url}/`, operation('a1'));
      const headings = await engine.locate!(
        { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } },
        operation('a1'),
      );
      // Proof the attempt ran over the attached remote, not a local launch.
      expect(headings[0]?.name).toBe('Home');
      expect(await engine.url!(operation('a1'))).toBe(`${app.url}/`);
      await engine.endAttempt!(cleanup());
    } finally {
      await engine.dispose!(cleanup());
    }

    // Dispose detaches the CDP session; the remote the host owns is still alive.
    expect(chrome.proc.exitCode).toBeNull();
  }, 60_000);

  it('reacquires a dropped remote at the next attempt by resolving the endpoint again', async () => {
    let current = chrome;
    let resolved = 0;
    const engine: EngineHandle = playwright({
      connect: {
        cdpEndpoint: () => {
          resolved += 1;
          return current.endpoint;
        },
      },
    });
    await engine.init!({
      runId: 'run-cdp',
      targetName: 'web',
      projectRoot: process.cwd(),
      app: { baseUrl: app.url, allowedOrigins: [new URL(app.url).origin] },
      testIdAttribute: 'data-testid',
      headed: false,
      signal: new AbortController().signal,
    });
    try {
      await engine.startAttempt!({ attemptId: 'r1', artifactsDir, signal: new AbortController().signal });
      await engine.app!.navigate!(`${app.url}/`, operation('r1'));
      await engine.endAttempt!(cleanup());
      expect(resolved).toBe(1);

      // The host's session goes away: kill the remote and stand up a fresh one
      // at a new endpoint, the way a per-run cloud session is re-provisioned.
      await closeRemoteChrome(chrome);
      expect(existsSync(chrome.userDataDir)).toBe(false);
      const replacement = await launchRemoteChrome();
      current = replacement;
      chrome = replacement;

      // The next attempt must not fail on the dead browser: it reacquires,
      // running the resolver again, and works over the new session.
      await engine.startAttempt!({ attemptId: 'r2', artifactsDir, signal: new AbortController().signal });
      expect(resolved).toBe(2);
      await engine.app!.navigate!(`${app.url}/`, operation('r2'));
      const headings = await engine.locate!(
        { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } },
        operation('r2'),
      );
      expect(headings[0]?.name).toBe('Home');
      await engine.endAttempt!(cleanup());
    } finally {
      await engine.dispose!(cleanup());
    }
  }, 90_000);

  it('never caches a browser that connects after the init was cancelled', async () => {
    let resolved = 0;
    const controller = new AbortController();
    const engine: EngineHandle = playwright({
      connect: {
        cdpEndpoint: () => {
          resolved += 1;
          // Cancel right after the endpoint is handed back, so the attach
          // completes into an already-aborted init.
          queueMicrotask(() => controller.abort());
          return chrome.endpoint;
        },
      },
    });
    const info = {
      runId: 'run-cdp',
      targetName: 'web',
      projectRoot: process.cwd(),
      app: { baseUrl: app.url, allowedOrigins: [new URL(app.url).origin] },
      testIdAttribute: 'data-testid',
      headed: false,
    };
    await expect(engine.init!({ ...info, signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(resolved).toBe(1);

    // A fresh init must provision again. Were the late browser cached, the pool
    // would hand it back without consulting the resolver.
    await engine.init!({ ...info, signal: new AbortController().signal });
    try {
      expect(resolved).toBe(2);
    } finally {
      await engine.dispose!(cleanup());
    }
    // And the remote the host owns was detached, not killed.
    expect(chrome.proc.exitCode).toBeNull();
  }, 60_000);
});
