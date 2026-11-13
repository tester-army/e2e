import { afterEach, expect, it, vi } from 'vitest';
import { connectCdp } from '../../src/browser-connection.ts';

const connect = vi.hoisted(() => vi.fn());
vi.mock('playwright-core', () => ({ chromium: { connectOverCDP: connect }, selectors: { register: async () => undefined } }));
afterEach(() => vi.resetAllMocks());

it.each(['x', 'Bearer synthetic-token', 'Custom synthetic-token'])('keeps authenticated connection errors free of arbitrary header values: %s', async (value) => {
  const cause = new Error(`WebSocket error: ${value}, synthetic-token`, { cause: new Error(value) });
  cause.name = 'TimeoutError';
  connect.mockRejectedValue(cause);
  const failure = await connectCdp({ endpoint: 'wss://browser.example', headers: { Custom: value } }, 1000).catch((error: unknown) => error);
  expect(failure).toMatchObject({ name: 'TimeoutError', message: 'CDP connection failed; check the endpoint, handshake headers, and connection timeout' });
  expect(failure).not.toHaveProperty('cause');
  expect((failure as Error).stack).not.toContain('synthetic-token');
});

it('preserves the original connection failure when there are no handshake headers', async () => {
  const cause = new Error('connection refused');
  connect.mockRejectedValue(cause);
  await expect(connectCdp({ endpoint: 'wss://browser.example' }, 1000)).rejects.toBe(cause);
});
