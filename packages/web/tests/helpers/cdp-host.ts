/** A local Chrome process owned independently of the engine's CDP transport. */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

/** A live Chrome with a random remote-debugging port; the host the engine attaches to. */
export interface RemoteChrome {
  readonly endpoint: string;
  readonly proc: ChildProcess;
  readonly userDataDir: string;
  readonly closed: Promise<void>;
}

/** Waits for Chrome and its stdio to close before removing the profile it writes. */
export async function closeRemoteChrome(chrome: Omit<RemoteChrome, 'endpoint'>): Promise<void> {
  if (chrome.proc.exitCode === null && chrome.proc.signalCode === null) chrome.proc.kill('SIGKILL');
  await chrome.closed;
  rmSync(chrome.userDataDir, { recursive: true, force: true });
}

/** Launches the remote host and releases its resources if it never becomes ready. */
export async function launchRemoteChrome(): Promise<RemoteChrome> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'e2e-cdp-host-'));
  // The sandbox flags are what a containerized CI runner needs to start Chrome
  // at all; they change nothing about the attach under test.
  const proc = spawn(chromium.executablePath(), [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
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
