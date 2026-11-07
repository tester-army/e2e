/** The surface resolves the Chromium sandbox from the option first, the run's environment second, and on by default. */
import type { Browser } from 'playwright-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EngineInitInfo } from 'e2e/engine';
import { PlaywrightSurface, type WebOptions } from '../../src/surface.ts';

const acquire = vi.hoisted(() => vi.fn());
vi.mock('../../src/browser-connection.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/browser-connection.ts')>()),
  BrowserConnection: class {
    acquire = acquire;
    dispose = async () => undefined;
  },
  connectCdp: vi.fn(),
}));

let surfaces: PlaywrightSurface[] = [];

/** Inits a surface for the options and environment, returning the sandbox flag its launch took. */
async function launchedSandbox(options: WebOptions, env: Readonly<Record<string, string | undefined>>): Promise<unknown> {
  const browser = {} as unknown as Browser;
  acquire.mockReset();
  acquire.mockResolvedValue(browser);
  const surface = new PlaywrightSurface(options);
  surfaces.push(surface);
  const info: EngineInitInfo = {
    runId: 'run',
    targetName: 'web',
    projectRoot: process.cwd(),
    app: {},
    env,
    headed: false,
    workerSlot: 0,
    signal: new AbortController().signal,
    log: () => undefined,
  };
  await surface.init(info);
  expect(acquire).toHaveBeenCalledOnce();
  return acquire.mock.calls[0]![3];
}

afterEach(async () => {
  for (const surface of surfaces) {
    await surface.dispose({ timeoutMs: 1_000, signal: new AbortController().signal });
  }
  surfaces = [];
});

beforeEach(() => {
  acquire.mockReset();
});

it('launches with the sandbox on when neither the option nor the environment says otherwise', async () => {
  await expect(launchedSandbox({}, {})).resolves.toBe(true);
});

it('launches with the sandbox off when the option says so', async () => {
  await expect(launchedSandbox({ chromiumSandbox: false }, {})).resolves.toBe(false);
});

it('launches with the sandbox off when the environment says so', async () => {
  await expect(launchedSandbox({}, { E2E_CHROMIUM_SANDBOX: '0' })).resolves.toBe(false);
  await expect(launchedSandbox({}, { E2E_CHROMIUM_SANDBOX: 'false' })).resolves.toBe(false);
});

it('leaves the sandbox on for any other environment value', async () => {
  await expect(launchedSandbox({}, { E2E_CHROMIUM_SANDBOX: '1' })).resolves.toBe(true);
  await expect(launchedSandbox({}, { E2E_CHROMIUM_SANDBOX: '' })).resolves.toBe(true);
});

it('lets an explicit option win over the environment either way', async () => {
  await expect(launchedSandbox({ chromiumSandbox: false }, { E2E_CHROMIUM_SANDBOX: '1' })).resolves.toBe(false);
  await expect(launchedSandbox({ chromiumSandbox: true }, { E2E_CHROMIUM_SANDBOX: '0' })).resolves.toBe(true);
});

it('does not read the flag from the process environment', async () => {
  // The process environment never decides a launch: an in-process worker
  // shares its process with the runner and every other target.
  vi.stubEnv('E2E_CHROMIUM_SANDBOX', '0');
  try {
    await expect(launchedSandbox({}, {})).resolves.toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});
