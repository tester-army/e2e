/** Which steps may confirm a staged action trace (cache/context.ts). */

import { describe, expect, it } from 'vitest';
import { isVerificationStep } from '../../src/run/steps.ts';

describe('isVerificationStep', () => {
  it.each([
    ['assertion', 'expect.toHaveText'],
    ['locator', 'locator.waitFor'],
    ['agent', 'agent.assert'],
    ['agent', 'agent.waitFor'],
  ] as const)('accepts %s %s', (kind, api) => {
    expect(isVerificationStep({ kind, api })).toBe(true);
  });

  it.each([
    ['agent', 'agent.act'],
    ['agent', 'agent.extract'],
    ['locator', 'locator.click'],
    ['app', 'app.open'],
    ['screen', 'screen.swipe'],
    ['session', 'session.save'],
    ['resource', 'resource.acquire'],
  ] as const)('rejects %s %s — it produces state rather than checking it', (kind, api) => {
    expect(isVerificationStep({ kind, api })).toBe(false);
  });
});
