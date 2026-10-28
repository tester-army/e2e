/** The CDP compatibility boundary must support Playwright's proxy channel and fail closed otherwise. */
import type { BrowserContext, Page } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import { registerCdpSelectors, requireCdpShadowTracking } from '../../src/cdp-selectors.ts';
import { SELECTOR_ENGINES } from '../../src/selector-engines.ts';
import { CLOSED_SHADOW_ROOTS_KEY } from '../../src/closed-shadow.ts';

const budget = () => ({ timeoutMs: 500, signal: new AbortController().signal });

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

it('refuses CDP recovery when closed tracking predates captured-native masks', async () => {
  const key = Symbol.for(CLOSED_SHADOW_ROOTS_KEY);
  const record = new WeakMap();
  const evaluate = async (read: (key: string) => boolean, argument: string) => read(argument);
  const page = { frames: () => [{ evaluate }] } as unknown as Page;
  Object.defineProperty(globalThis, key, { value: record, configurable: true });
  try {
    await expect(requireCdpShadowTracking(page, budget())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    Object.defineProperties(record, { maskDOMVersion: { value: 1 }, querySecureFields: { value: () => [] } });
    await expect(requireCdpShadowTracking(page, budget())).resolves.toBeUndefined();
  } finally { Reflect.deleteProperty(globalThis, key); }
});
