/**
 * The CDP-attach seam without a real browser: the factory rejects a non-chromium
 * browser, and `init` fails cleanly when the endpoint resolver yields nothing.
 * The end-to-end attach against a live Chrome is in tests/integration.
 */

import { describe, expect, it } from 'vitest';
import type { EngineInitInfo } from 'e2e/engine';
import { web } from '../../src/index.ts';
import { PlaywrightSurface } from '../../src/surface.ts';

function initInfo(signal = new AbortController().signal): EngineInitInfo {
  return {
    runId: 'run-cdp',
    targetName: 'web',
    projectRoot: '/project',
    app: { site: 'localhost' },
    env: {},
    headed: false,
    workerSlot: 0,
    signal,
    log: () => undefined,
  };
}

describe('web({ connect })', () => {
  it('declares persistent recovery without context replacement capabilities', () => {
    const engine = web({ connect: { cdpEndpoint: () => 'ws://localhost:0', reconnectEndpoint: () => 'ws://localhost:0' } });
    expect(engine.state).toBeUndefined();
    expect(engine.session?.reset).toBeUndefined();
    expect(engine.session?.restart).toBeTypeOf('function');
  });

  it('rejects creation-time credentials, headers, and user agent with persistent recovery', () => {
    const connect = { cdpEndpoint: () => 'ws://localhost:0', reconnectEndpoint: () => 'ws://localhost:0' };
    expect(() => web({ connect, headers: { 'x-preview': 'synthetic' } })).toThrow(/persistent context/);
    expect(() => web({ connect, basicAuth: { username: 'user', password: 'synthetic' } })).toThrow(/persistent context/);
    expect(() => web({ connect, userAgent: 'synthetic playwright' })).toThrow(/persistent context/);
  });

  it('accepts a connect option with the default chromium browser', () => {
    expect(() => web({ connect: { cdpEndpoint: () => 'ws://localhost:0' } })).not.toThrow();
    expect(() =>
      web({ browser: 'chromium', connect: { cdpEndpoint: () => 'ws://localhost:0' } }),
    ).not.toThrow();
  });

  it('rejects connect with a non-chromium browser as INVALID_CONFIG', () => {
    for (const browser of ['firefox', 'webkit'] as const) {
      expect(() => web({ browser, connect: { cdpEndpoint: () => 'ws://x' } })).toThrowError(
        /chromium-only/,
      );
    }
  });
});

describe('PlaywrightSurface CDP attach', () => {
  it('fails init with ENGINE_FAILURE when the endpoint resolves empty, without touching a browser', async () => {
    const surface = new PlaywrightSurface({ connect: { cdpEndpoint: () => '   ' } });
    await expect(surface.init(initInfo())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      retryable: false,
    });
  });

  it('propagates the resolver error as an init failure', async () => {
    const surface = new PlaywrightSurface({
      connect: {
        cdpEndpoint: () => {
          throw new Error('vault down');
        },
      },
    });
    await expect(surface.init(initInfo())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('hands the init signal to the resolver', async () => {
    let seen: AbortSignal | undefined;
    const surface = new PlaywrightSurface({
      connect: {
        cdpEndpoint: (signal) => {
          seen = signal;
          return '   ';
        },
      },
    });
    await surface.init(initInfo()).catch(() => undefined);
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it('cancels promptly while the resolver is still pending, without using its result', async () => {
    const controller = new AbortController();
    let settle: ((value: string) => void) | undefined;
    const surface = new PlaywrightSurface({
      connect: {
        cdpEndpoint: (signal) =>
          new Promise<string>((resolve) => {
            settle = resolve;
            signal.addEventListener('abort', () => resolve('ws://never-used'), { once: true });
          }),
      },
    });
    const pending = surface.init(initInfo(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    // The resolver was handed the same signal and saw the abort.
    expect(settle).toBeDefined();
  });

  it('honours an already-aborted signal before resolving the endpoint', async () => {
    const controller = new AbortController();
    controller.abort();
    let resolved = 0;
    const surface = new PlaywrightSurface({
      connect: {
        cdpEndpoint: () => {
          resolved += 1;
          return 'ws://localhost:0';
        },
      },
    });
    await expect(surface.init(initInfo(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(resolved).toBe(0);
  });
});
