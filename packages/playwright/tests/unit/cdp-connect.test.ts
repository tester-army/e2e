/**
 * The CDP-attach seam without a real browser: the factory rejects a non-chromium
 * engine, and `init` fails cleanly when the endpoint resolver yields nothing.
 * The end-to-end attach against a live Chrome is in tests/integration.
 */

import { describe, expect, it } from 'vitest';
import type { BackendInitInfo } from 'e2e/backend';
import { playwright } from '../../src/index.ts';
import { PlaywrightSurface } from '../../src/surface.ts';

function initInfo(signal = new AbortController().signal): BackendInitInfo {
  return {
    runId: 'run-cdp',
    targetName: 'web',
    app: { baseUrl: 'http://localhost/', allowedOrigins: ['http://localhost'] },
    testIdAttribute: 'data-testid',
    headed: false,
    signal,
  };
}

describe('playwright({ connect })', () => {
  it('accepts a connect option with the default chromium engine', () => {
    expect(() => playwright({ connect: { cdpEndpoint: () => 'ws://localhost:0' } })).not.toThrow();
    expect(() =>
      playwright({ browser: 'chromium', connect: { cdpEndpoint: () => 'ws://localhost:0' } }),
    ).not.toThrow();
  });

  it('rejects connect with a non-chromium engine as INVALID_CONFIG', () => {
    for (const browser of ['firefox', 'webkit'] as const) {
      expect(() => playwright({ browser, connect: { cdpEndpoint: () => 'ws://x' } })).toThrowError(
        /chromium-only/,
      );
    }
  });
});

describe('PlaywrightSurface CDP attach', () => {
  it('fails init with BACKEND_FAILURE when the endpoint resolves empty, without touching a browser', async () => {
    const surface = new PlaywrightSurface({ connect: { cdpEndpoint: () => '   ' } });
    await expect(surface.init(initInfo())).rejects.toMatchObject({
      code: 'BACKEND_FAILURE',
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
    await expect(surface.init(initInfo())).rejects.toMatchObject({ code: 'BACKEND_FAILURE' });
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
