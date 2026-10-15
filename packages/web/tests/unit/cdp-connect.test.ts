/**
 * The CDP-attach seam without a real browser: the factory rejects a non-chromium
 * browser, and `init` fails cleanly when the endpoint resolver yields nothing.
 * The end-to-end attach against a live Chrome is in tests/integration.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EngineInitInfo } from 'e2e/engine';
import { web, type WebConnectOptions } from '../../src/index.ts';
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
  it('declares persistent recovery without context replacement capabilities, and names why a reset is refused', async () => {
    const engine = web({ connect: { cdpEndpoint: () => 'ws://localhost:0', reconnectEndpoint: () => 'ws://localhost:0' } });
    expect(engine.state).toBeUndefined();
    await expect(engine.session!.reset!({ timeoutMs: 1_000, signal: new AbortController().signal, runId: 'run-connect', attemptId: 'a1', origin: 'test' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'app.clearState() is unavailable with connect.reconnectEndpoint: it replaces the browser context, and the attempt rides one persistent context',
    });
    expect(engine.session?.restart).toBeTypeOf('function');
  });

  it('rejects creation-time credentials, headers, user agent, locale, and time zone with persistent recovery', () => {
    const connect = { cdpEndpoint: () => 'ws://localhost:0', reconnectEndpoint: () => 'ws://localhost:0' };
    expect(() => web({ connect, headers: { 'x-preview': 'synthetic' } })).toThrow(/persistent context/);
    expect(() => web({ connect, basicAuth: { username: 'user', password: 'synthetic' } })).toThrow(/persistent context/);
    expect(() => web({ connect, userAgent: 'synthetic playwright' })).toThrow(/persistent context/);
    expect(() => web({ connect, locale: 'de-DE' })).toThrow(/persistent context; locale requires/);
    expect(() => web({ connect, timezoneId: 'Europe/Berlin' })).toThrow(/persistent context; timezoneId requires/);
  });

  it('rejects connect with a non-chromium browser as INVALID_CONFIG', () => {
    for (const browser of ['firefox', 'webkit'] as const) {
      expect(() => web({ browser, connect: { cdpEndpoint: () => 'ws://x' } })).toThrowError(
        /chromium-only/,
      );
    }
  });

  it('rejects connect without a cdpEndpoint resolver as INVALID_CONFIG at config load, never echoing an endpoint', () => {
    const refused = (message: RegExp) => expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
    const resolver = () => 'ws://localhost:0';
    const url = 'ws://host/devtools/browser/session-token';
    const connect = (value: unknown) => () => web({ connect: value as WebConnectOptions });
    // reconnectEndpoint alone used to pass load and fail every attempt with "resolve is not a function".
    expect(connect({ reconnectEndpoint: resolver })).toThrow(refused(/requires cdpEndpoint.*reconnectEndpoint only reconnects/));
    expect(connect({})).toThrow(refused(/requires cdpEndpoint, the resolver that provisions the browser/));
    expect(connect({ cdpEndpoint: url })).toThrow(refused(/cdpEndpoint.*must be a resolver function.*got a string$/));
    expect(connect({ cdpEndpoint: resolver, reconnectEndpoint: url })).toThrow(refused(/reconnectEndpoint.*must be a resolver function.*got a string$/));
    expect(connect(url)).toThrow(refused(/connect.*must be a plain object.*got a string$/));
    expect(connect(null)).toThrow(refused(/must be a plain object.*got null$/));
    expect(connect([resolver])).toThrow(refused(/must be a plain object.*got an array$/));
    for (const value of [{ cdpEndpoint: url }, { cdpEndpoint: resolver, reconnectEndpoint: url }, url]) {
      expect(connect(value)).toThrow(expect.objectContaining({ message: expect.not.stringContaining('session-token') }));
    }
  });
});

describe('PlaywrightSurface CDP attach', () => {
  it('fails init with ENGINE_FAILURE when the endpoint resolves empty or the resolver throws, without touching a browser', async () => {
    const empty = new PlaywrightSurface({ connect: { cdpEndpoint: () => '   ' } });
    await expect(empty.init(initInfo())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      retryable: false,
      message: expect.stringContaining('connect.cdpEndpoint resolved to an empty CDP endpoint'),
    });
    const throwing = new PlaywrightSurface({
      connect: {
        cdpEndpoint: () => {
          throw new Error('vault down');
        },
      },
    });
    await expect(throwing.init(initInfo())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('vault down'),
    });
  });

  it('hands the init signal to the resolver and cancels promptly while it is still pending', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const surface = new PlaywrightSurface({
      connect: {
        cdpEndpoint: (signal) => {
          seen = signal;
          return new Promise<string>(() => undefined);
        },
      },
    });
    const pending = surface.init(initInfo(controller.signal));
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen!.aborted).toBe(false);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(seen!.aborted).toBe(true);
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
