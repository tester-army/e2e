/**
 * The driver-neutral route handler contract both drivers' fixtures run:
 * exactly one decision, options checked before it, and every failure
 * latched with the request aborted rather than left pending.
 */

import { describe, expect, it } from 'vitest';
import type { EngineFixtureContext } from 'e2e/engine';
import { runRouteHandler, type RouteAdapter } from '../../src/browser-calls.ts';

const context = { app: { resolveUrl: (url: string) => new URL(url, 'http://app.test').href } } as EngineFixtureContext;

/** A route adapter that records what the route decided. */
function adapter() {
  const calls: string[] = [];
  const held: RouteAdapter = {
    request: { url: 'http://app.test/api/users', method: 'GET', headers: {} },
    fetch: async () => ({ url: '', status: 200, headers: {}, body: async () => Buffer.alloc(0), json: async () => null as never, text: async () => '' }),
    fulfill: async (decision) => void calls.push(`fulfill ${decision.status}`),
    continue: async (decision) => void calls.push(`continue ${decision.url ?? ''}`),
    fallback: async () => void calls.push('fallback'),
    abort: async () => void calls.push('abort'),
  };
  return { held, calls };
}

describe('runRouteHandler', () => {
  it('passes one decision to the adapter', async () => {
    const { held, calls } = adapter();
    const latched: Error[] = [];
    await runRouteHandler((route) => route.fulfill({ status: 204 }), held, (error) => latched.push(error), context, (file) => file);
    await runRouteHandler((route) => route.continue({ url: '/v2/users' }), held, (error) => latched.push(error), context, (file) => file);
    expect(calls).toEqual(['fulfill 204', 'continue http://app.test/v2/users']);
    expect(latched).toEqual([]);
  });

  it('latches a second decision', async () => {
    const { held, calls } = adapter();
    const latched: Error[] = [];
    await runRouteHandler(async (route) => {
      await route.abort();
      await route.fallback();
    }, held, (error) => latched.push(error), context, (file) => file);
    expect(calls).toEqual(['abort']);
    expect(latched.map((error) => error.message)).toEqual(['route handler already decided; fallback called twice']);
  });

  it('aborts and latches a handler that returns undecided or throws', async () => {
    const undecided = adapter();
    const latched: Error[] = [];
    await runRouteHandler(async () => undefined, undecided.held, (error) => latched.push(error), context, (file) => file);
    const throwing = adapter();
    await runRouteHandler(() => {
      throw new Error('handler exploded');
    }, throwing.held, (error) => latched.push(error), context, (file) => file);
    expect(undecided.calls).toEqual(['abort']);
    expect(throwing.calls).toEqual(['abort']);
    expect(latched.map((error) => error.message)).toEqual([
      'route handler returned without calling fulfill, continue, fallback, or abort',
      'handler exploded',
    ]);
  });

  it('refuses invalid options before deciding, so the request is still aborted', async () => {
    const { held, calls } = adapter();
    const latched: Error[] = [];
    await runRouteHandler((route) => route.fulfill({ status: 42 }), held, (error) => latched.push(error), context, (file) => file);
    expect(calls).toEqual(['abort']);
    expect(latched[0]).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
