/**
 * The AI SDK loader cache must live on globalThis, not in module state:
 * config and test modules load in an isolated tsx realm, so an executor
 * constructed in config code (which primes the cache in its realm's module
 * copy) and the runner's synchronous gateway-model seam would otherwise see
 * two separate caches. Found live by dogfooding: a config-file
 * `createAgent()` with a gateway model crashed the runner-realm `aiSdk()`
 * with "has not been loaded".
 */

import { describe, expect, it, vi } from 'vitest';

describe('ai-sdk loader cache', () => {
  it('shares the loaded SDK across module realms via the globalThis slot', async () => {
    const first = await import('../../src/agent/ai-sdk.ts');
    await first.loadAiSdk();
    // A fresh module registry simulates the tsx realm's separate module copy.
    vi.resetModules();
    const second = await import('../../src/agent/ai-sdk.ts');
    expect(second).not.toBe(first);
    expect(() => second.aiSdk()).not.toThrow();
    expect(second.aiSdk()).toBe(await first.loadAiSdk());
  });
});
