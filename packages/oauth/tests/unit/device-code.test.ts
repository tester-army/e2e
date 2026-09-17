import { describe, expect, it } from 'vitest';
import { OAuthError, runDeviceFlow, type DevicePoll } from '../../src/index.ts';

const authorization = { deviceCode: 'dev', userCode: 'ABCD-1234', verificationUri: 'https://x/device', expiresIn: 60, interval: 5 };

function flow(polls: DevicePoll<string>[], sleeps: number[]) {
  const queue = [...polls];
  let onAuth: unknown;
  return {
    run: () =>
      runDeviceFlow<string>({
        start: async () => authorization,
        poll: async () => queue.shift() ?? { status: 'pending' },
        callbacks: { onAuth: (info) => (onAuth = info), onPrompt: async () => '' },
        sleep: async (ms) => void sleeps.push(ms),
      }),
    info: () => onAuth,
  };
}

describe('runDeviceFlow', () => {
  it('polls through pending and slow_down, then returns the grant', async () => {
    const sleeps: number[] = [];
    const { run, info } = flow([{ status: 'pending' }, { status: 'slow_down' }, { status: 'pending' }, { status: 'granted', value: 'tok' }], sleeps);
    await expect(run()).resolves.toBe('tok');
    expect(info()).toMatchObject({ url: 'https://x/device', userCode: 'ABCD-1234' });
    // 5 s interval, then +5 s after slow_down.
    expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
  });

  it('honours the interval a slow_down names', async () => {
    const sleeps: number[] = [];
    const { run } = flow([{ status: 'slow_down', intervalSeconds: 2 }, { status: 'granted', value: 'ok' }], sleeps);
    await run();
    expect(sleeps).toEqual([5000, 2000]);
  });

  it('turns denial and expiry into OAuthErrors', async () => {
    await expect(flow([{ status: 'denied' }], []).run()).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(flow([{ status: 'expired' }], []).run()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('stops when the device code lifetime runs out', async () => {
    let now = 0;
    const promise = runDeviceFlow<string>({
      start: async () => ({ ...authorization, expiresIn: 12 }),
      poll: async () => ({ status: 'pending' }),
      callbacks: { onAuth() {}, onPrompt: async () => '' },
      sleep: async (ms) => void (now += ms),
      now: () => now,
    });
    await expect(promise).rejects.toBeInstanceOf(OAuthError);
  });

  it('stops at an abort signal', async () => {
    const controller = new AbortController();
    const promise = runDeviceFlow<string>({
      start: async () => authorization,
      poll: async () => ({ status: 'pending' }),
      callbacks: { onAuth: () => controller.abort(), onPrompt: async () => '', signal: controller.signal },
    });
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
