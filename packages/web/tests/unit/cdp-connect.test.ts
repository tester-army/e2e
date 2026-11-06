/**
 * The CDP-attach seam without a real browser: the factory rejects a non-chromium
 * browser, and `init` fails cleanly when the endpoint resolver yields nothing.
 * The end-to-end attach against a live Chrome is in tests/integration.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EngineInitInfo } from 'e2e/engine';
import { web, type WebConnectOptions } from '../../src/index.ts';

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
  it('refuses a persistent remote context, naming the attach it takes instead', () => {
    const connect = { cdpEndpoint: () => 'ws://localhost:0', reconnectEndpoint: () => 'ws://localhost:0' };
    expect(() => web({ connect })).toThrow(expect.objectContaining({
      code: 'INVALID_CONFIG',
      message: expect.stringMatching(/connect\.reconnectEndpoint is not supported.*use connect\.cdpEndpoint/),
    }));
  });

  it('rejects connect with a non-chromium browser as INVALID_CONFIG', () => {
    expect(() => web({ browser: 'firefox', connect: { cdpEndpoint: () => 'ws://x' } })).toThrowError(/chromium-only/);
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

describe('CDP attach at init', () => {
  it('fails init with ENGINE_FAILURE when the endpoint resolves empty, without touching a browser', async () => {
    const empty = web({ connect: { cdpEndpoint: () => '   ' } });
    await expect(empty.init!(initInfo())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      retryable: false,
      message: expect.stringContaining('connect.cdpEndpoint resolved to an empty CDP endpoint'),
    });
  });

  it('fails init with ENGINE_FAILURE when the resolver throws, naming its failure', async () => {
    const throwing = web({
      connect: {
        cdpEndpoint: () => {
          throw new Error('vault down');
        },
      },
    });
    await expect(throwing.init!(initInfo())).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('vault down'),
    });
  });

  it('hands the init signal to the resolver and cancels promptly while it is still pending', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const engine = web({
      connect: {
        cdpEndpoint: (signal: AbortSignal) => {
          seen = signal;
          return new Promise<string>(() => undefined);
        },
      },
    });
    const pending = engine.init!(initInfo(controller.signal));
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
    const engine = web({
      connect: {
        cdpEndpoint: () => {
          resolved += 1;
          return 'ws://localhost:0';
        },
      },
    });
    await expect(engine.init!(initInfo(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(resolved).toBe(0);
  });
});
