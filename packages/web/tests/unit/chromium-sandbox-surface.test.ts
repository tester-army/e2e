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
  return (acquire.mock.calls[0]![0] as { chromiumSandbox: unknown }).chromiumSandbox;
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

it('trims and lowercases the environment value', async () => {
  await expect(launchedSandbox({}, { E2E_CHROMIUM_SANDBOX: ' 0 ' })).resolves.toBe(false);
  await expect(launchedSandbox({}, { E2E_CHROMIUM_SANDBOX: 'FALSE' })).resolves.toBe(false);
  await expect(launchedSandbox({}, { E2E_CHROMIUM_SANDBOX: ' False ' })).resolves.toBe(false);
  await expect(launchedSandbox({}, { E2E_CHROMIUM_SANDBOX: ' TRUE ' })).resolves.toBe(true);
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

/** Inits a surface whose launch throws, returning the error `init` rethrows. */
async function launchFailure(cause: Error): Promise<unknown> {
  acquire.mockReset();
  acquire.mockRejectedValue(cause);
  const surface = new PlaywrightSurface({});
  surfaces.push(surface);
  try {
    await surface.init({
      runId: 'run',
      targetName: 'web',
      projectRoot: process.cwd(),
      app: {},
      env: {},
      headed: false,
      workerSlot: 0,
      signal: new AbortController().signal,
      log: () => undefined,
    });
  } catch (error) {
    return error;
  }
  throw new Error('expected init to throw');
}

it('turns a sandbox launch failure into a friendly error naming both opt-outs', async () => {
  const error = (await launchFailure(
    new Error(
      'browserType.launch: Target page, context or browser has been closed\n' +
        'Chromium sandboxing failed!\n' +
        'Call log:\n' +
        '  - launching Chromium with --no-sandbox --flag-a --flag-b',
    ),
  )) as Error & { code?: unknown };
  expect(error.code).toBe('ENGINE_FAILURE');
  expect(error.message).toContain('E2E_CHROMIUM_SANDBOX=0');
  expect(error.message).toContain('web({ chromiumSandbox: false })');
  expect(error.message).not.toContain('Call log');
  expect(error.message).not.toContain('--flag-a');
  expect(error.cause).toBeUndefined();
});

it('keeps any other launch failure wrapped as before', async () => {
  const error = (await launchFailure(new Error('browserType.launch: executable does not exist'))) as Error & { code?: unknown };
  expect(error.code).toBe('ENGINE_FAILURE');
  expect(error.message).toBe('browser launch failed: browserType.launch: executable does not exist');
});
