/** The CDP compatibility boundary must support Playwright's proxy channel and fail closed otherwise. */
import type { BrowserContext } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import { registerCdpSelectors } from '../../src/cdp-selectors.ts';
import { SELECTOR_ENGINES } from '../../src/selector-engines.ts';

const budget = () => ({ timeoutMs: 500, signal: new AbortController().signal });

it('registers every owned selector engine, and nothing else, through a dynamically generated channel method', async () => {
  const register = vi.fn(async () => undefined);
  const channel = new Proxy({}, { get: (_target, key) => key === 'registerSelectorEngine' ? register : undefined });
  const options = budget();
  await registerCdpSelectors({ _channel: channel } as unknown as BrowserContext, options);
  expect(SELECTOR_ENGINES.map(({ name }) => name)).toEqual(['e2e-closed', 'e2e-roots', 'e2e-label', 'e2e-read', 'e2e-shown']);
  expect(register).toHaveBeenCalledTimes(SELECTOR_ENGINES.length);
  for (const { name, source } of SELECTOR_ENGINES) {
    expect(register).toHaveBeenCalledWith({ selectorEngine: {
      name, source: `(${source})(undefined)`, contentScript: false,
    } }, { timeout: options.timeoutMs, signal: options.signal });
  }
});

it('refuses an unsupported context before any locator or capture can run, naming both', async () => {
  await expect(registerCdpSelectors({} as BrowserContext, budget())).rejects.toMatchObject({
    code: 'UNSUPPORTED_CAPABILITY',
    message: expect.stringMatching(/locators and secure-field masks/),
  });
});

it('tolerates only the exact owned-name duplicates from a version that already seeded the context', async () => {
  const register = vi.fn();
  for (const { name } of SELECTOR_ENGINES) {
    register.mockRejectedValueOnce(new Error(`"${name}" selector engine has been already registered`));
  }
  register.mockRejectedValueOnce(new Error('"other" selector engine has been already registered'));
  const context = { _channel: { registerSelectorEngine: register } } as unknown as BrowserContext;
  await expect(registerCdpSelectors(context, budget())).resolves.toBeUndefined();
  await expect(registerCdpSelectors(context, budget())).rejects.toThrow('"other"');
});
