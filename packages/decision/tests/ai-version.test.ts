import { describe, expect, it, vi } from 'vitest';
import { decisionExecutor } from '../src/index.ts';
import { scriptedDecision } from './helpers.ts';

vi.mock('ai', async (original) => ({ ...(await original<typeof import('ai')>()), experimental_decide: undefined }));

describe('an ai release without experimental_decide', () => {
  it('loads the package and fails config load naming the version to install', () => {
    const { model } = scriptedDecision(() => ({ choice: 'done' }));
    expect(() => decisionExecutor({ model })).toThrow(expect.objectContaining({
      code: 'INVALID_CONFIG',
      message: 'decisionExecutor() needs ai 7.0.134 or later; update the ai package',
    }));
  });
});
