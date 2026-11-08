import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request } from '../../src/http.ts';

const headers = { Authorization: 'Bearer synthetic-secret' };
const call = (signal = new AbortController().signal) => request('https://api.cloudflare.com/test', 'POST', headers, signal);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-08T12:00:00Z')); });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['2', 'Sun, 08 Nov 2026 12:00:02 GMT'])('honors Retry-After %s before retrying a rejected acquisition', async (retryAfter) => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } }))
    .mockResolvedValueOnce(Response.json({ sessionId: 'ok' }));

  vi.stubGlobal('fetch', fetch);
  const pending = call();
  await vi.advanceTimersByTimeAsync(1_999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).ok).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('uses bounded backoff when Retry-After is absent or invalid', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 429, headers: { 'Retry-After': 'invalid' } }));
  vi.stubGlobal('fetch', fetch);
  const pending = expect(call()).rejects.toThrow(/HTTP 429.*after retries/);
  await vi.advanceTimersByTimeAsync(8_000);
  await pending;
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('cancels a Retry-After wait without issuing another request', async () => {
  const controller = new AbortController();
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }));
  vi.stubGlobal('fetch', fetch);
  const pending = expect(call(controller.signal)).rejects.toThrow('cancel acquisition');
  await vi.advanceTimersByTimeAsync(5);
  controller.abort(new Error('cancel acquisition'));
  await pending;
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not retry an indeterminate network failure that may have created a browser', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('network disconnected'));
  vi.stubGlobal('fetch', fetch);
  await expect(call()).rejects.toThrow('network disconnected');
  expect(fetch).toHaveBeenCalledOnce();
});

it('does not reset the acquisition budget after a retry', async () => {
  const budget = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    setTimeout(() => budget.abort(new Error('acquisition budget expired')), ms);

    return budget.signal;
  });
  const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 429, headers: { 'Retry-After': '20' } }));
  vi.stubGlobal('fetch', fetch);
  const pending = expect(call()).rejects.toThrow('acquisition budget expired');
  await vi.advanceTimersByTimeAsync(30_000);
  await pending;
  expect(fetch).toHaveBeenCalledTimes(2);
});
