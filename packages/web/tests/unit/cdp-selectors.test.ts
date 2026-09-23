/** The CDP compatibility boundary must support Playwright's proxy channel and fail closed otherwise. */
import type { BrowserContext } from 'playwright';
import { expect, it, vi } from 'vitest';
import { registerCdpSelectors } from '../../src/cdp-selectors.ts';
import {
  CLOSED_SHADOW_SELECTOR_ENGINE,
  CLOSED_SHADOW_SELECTOR_ENGINE_SOURCE,
  SEARCH_ROOTS_SELECTOR_ENGINE,
  SEARCH_ROOTS_SELECTOR_ENGINE_SOURCE,
} from '../../src/read-node.ts';

const budget = () => ({ timeoutMs: 500, signal: new AbortController().signal });

it('registers only the owned selectors through a dynamically generated channel method', async () => {
  const register = vi.fn(async () => undefined);
  const channel = new Proxy({}, { get: (_target, key) => key === 'registerSelectorEngine' ? register : undefined });
  const options = budget();
  await registerCdpSelectors({ _channel: channel } as unknown as BrowserContext, options);
  expect(register).toHaveBeenCalledTimes(2);
  expect(register).toHaveBeenCalledWith({ selectorEngine: {
    name: CLOSED_SHADOW_SELECTOR_ENGINE, source: `(${CLOSED_SHADOW_SELECTOR_ENGINE_SOURCE})(undefined)`, contentScript: false,
  } }, { timeout: options.timeoutMs, signal: options.signal });
  expect(register).toHaveBeenCalledWith({ selectorEngine: {
    name: SEARCH_ROOTS_SELECTOR_ENGINE, source: `(${SEARCH_ROOTS_SELECTOR_ENGINE_SOURCE})(undefined)`, contentScript: false,
  } }, { timeout: options.timeoutMs, signal: options.signal });
});

it('refuses an unsupported context before any capture can be treated as masked', async () => {
  await expect(registerCdpSelectors({} as BrowserContext, budget())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
});

it('tolerates only the exact owned-name duplicates from a version that already seeded the context', async () => {
  const register = vi.fn()
    .mockRejectedValueOnce(new Error(`"${CLOSED_SHADOW_SELECTOR_ENGINE}" selector engine has been already registered`))
    .mockRejectedValueOnce(new Error(`"${SEARCH_ROOTS_SELECTOR_ENGINE}" selector engine has been already registered`))
    .mockRejectedValueOnce(new Error('"other" selector engine has been already registered'));
  const context = { _channel: { registerSelectorEngine: register } } as unknown as BrowserContext;
  await expect(registerCdpSelectors(context, budget())).resolves.toBeUndefined();
  await expect(registerCdpSelectors(context, budget())).rejects.toThrow('"other"');
});
