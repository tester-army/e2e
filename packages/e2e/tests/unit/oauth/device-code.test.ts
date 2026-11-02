import { afterEach, describe, expect, it } from 'vitest';
import { OAuthError } from '../../../src/oauth/errors.ts';
import { rfc8628Flow, runDeviceFlow, type DevicePoll } from '../../../src/oauth/device-code.ts';
import { json, useServers, type Handler } from '../../helpers/recording-server.ts';
import { onFakeTimeouts } from './helpers/time.ts';

const serve = useServers(afterEach);

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
  it('does not start or display a device flow already cancelled', async () => {
    let starts = 0;
    let displays = 0;
    await expect(runDeviceFlow({
      start: async () => { starts += 1; return authorization; },
      poll: async () => ({ status: 'pending' }),
      callbacks: { onAuth: () => { displays += 1; }, onPrompt: async () => '', signal: AbortSignal.abort() },
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(starts).toBe(0);
    expect(displays).toBe(0);
  });

  it('passes cancellation to the initial request and reports a cancelled login', async () => {
    const controller = new AbortController();
    const promise = runDeviceFlow({
      start: async (signal) => new Promise<typeof authorization>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        controller.abort();
        if (signal === undefined) reject(new Error('initial request received no signal'));
      }),
      poll: async () => ({ status: 'pending' }),
      callbacks: { onAuth() {}, onPrompt: async () => '', signal: controller.signal },
    });
    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('does not display a device code received after cancellation', async () => {
    const controller = new AbortController();
    let displays = 0;
    await expect(runDeviceFlow({
      start: async () => { controller.abort(); return authorization; },
      poll: async () => ({ status: 'pending' }),
      callbacks: { onAuth: () => { displays += 1; }, onPrompt: async () => '', signal: controller.signal },
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(displays).toBe(0);
  });

  it('reports cancellation when an in-flight approval poll rejects', async () => {
    const controller = new AbortController();
    await expect(runDeviceFlow({
      start: async () => authorization,
      poll: async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); },
      sleep: async () => {},
      callbacks: { onAuth() {}, onPrompt: async () => '', signal: controller.signal },
    })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('preserves a non-cancellation initial request failure', async () => {
    const failure = new Error('device endpoint failed');
    await expect(runDeviceFlow({
      start: async () => { throw failure; },
      poll: async () => ({ status: 'pending' }),
      callbacks: { onAuth() {}, onPrompt: async () => '' },
    })).rejects.toBe(failure);
  });

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

describe('rfc8628Flow', () => {
  const deviceCode = { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://x/device', interval: 0.001 };

  /** Runs the flow against a local server answering the device code request with `start` and every poll with `poll`. */
  async function login(start: Handler, poll: Handler = (_request, response) => json(response, 400, { error: 'authorization_pending' })) {
    const server = await serve((request, response) => (request.url === '/code' ? start(request, response) : poll(request, response)));
    return onFakeTimeouts(() =>
      rfc8628Flow({ vendor: 'Acme', deviceCodeUrl: `${server.url}/code`, tokenUrl: `${server.url}/token`, clientId: 'c', request: {}, callbacks: { onAuth() {}, onPrompt: async () => '' } }),
    );
  }

  it('fails the flow on a device code response that is not JSON or not an object', async () => {
    await expect(login((_request, response) => void response.writeHead(200).end('<html>'))).rejects.toMatchObject({
      code: 'FLOW_FAILED',
      message: 'the Acme device code response is not JSON',
    });
    await expect(login((_request, response) => json(response, 200, null))).rejects.toMatchObject({
      code: 'FLOW_FAILED',
      message: 'the Acme device code response is missing fields',
    });
  });

  it('fails the flow on a poll answer that is not an object, naming the status', async () => {
    const start: Handler = (_request, response) => json(response, 200, deviceCode);
    await expect(login(start, (_request, response) => json(response, 400, null))).rejects.toMatchObject({
      code: 'FLOW_FAILED',
      message: 'Acme device login failed: 400',
    });
  });
});
