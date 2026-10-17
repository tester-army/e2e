import { describe, expect, it, vi } from 'vitest';
import { recorded } from '../src/budget.ts';
import { context } from './helpers.ts';
describe('model response accounting at cancellation', () => {
  it('records returned usage and actual model id while refusing the cancelled value', async () => {
    const controller = new AbortController();
    const fixture = context({ signal: controller.signal });
    const response = async () => {
      controller.abort(new Error('cancelled locally'));
      return { value: 'late answer', usage: { inputTokens: 17, outputTokens: 9 }, modelId: 'served-model' };
    };
    await expect(recorded(fixture.ctx, { provider: 'local', modelId: 'requested-model' }, response)).rejects.toThrow('cancelled locally');
    expect(fixture.usage).toHaveLength(1);
    expect(fixture.usage[0]).toMatchObject({ provider: 'local', modelId: 'served-model', inputTokens: 17, outputTokens: 9 });
  });
  it('does not start or account a call cancelled before dispatch', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before dispatch'));
    const fixture = context({ signal: controller.signal });
    const response = vi.fn(async () => ({ value: 'unused', usage: {} }));
    await expect(recorded(fixture.ctx, { provider: 'local', modelId: 'requested-model' }, response)).rejects.toThrow('cancelled before dispatch');
    expect(response).not.toHaveBeenCalled();
    expect(fixture.usage).toHaveLength(0);
  });
  it('keeps the requested model and no invented usage when a call fails', async () => {
    const fixture = context();
    await expect(recorded(fixture.ctx, { provider: 'local', modelId: 'requested-model' }, async () => { throw new Error('local failure'); })).rejects.toThrow('local failure');
    expect(fixture.usage).toHaveLength(1);
    expect(fixture.usage[0]).toMatchObject({ provider: 'local', modelId: 'requested-model' });
    expect(fixture.usage[0]).not.toHaveProperty('inputTokens');
  });
});
