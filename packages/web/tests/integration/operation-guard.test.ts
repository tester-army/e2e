/**
 * Every engine operation goes through one guard: an error a route handler
 * latched fails the next step once, with its own classification, and an
 * operation already cancelled, or cancelled mid-flight, ends as `CANCELLED`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('the operation guard', () => {
  let session: WebSession;

  beforeAll(async () => {
    session = await startWebSession({ startAttempt: false });
    session.serve('/', '<!doctype html><title>Guard</title><h1>Guard</h1>');
    session.serve('/never', () => undefined);
  });

  beforeEach(async () => {
    await session.startAttempt();
    await session.open(`${session.origin}/`);
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  it('fails the next step once with the error a route handler latched, then runs steps again', async () => {
    await session.browser.route('**/api/undecided', async () => undefined);
    await session.browser.evaluate(() => fetch('/api/undecided').then(() => 'answered', () => 'aborted'));
    await expect(session.observe()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('route handler returned without calling fulfill'),
    });
    await expect(session.observe()).resolves.toBeDefined();
  });

  it('refuses an operation whose signal already aborted as CANCELLED', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(session.engine.observe!({ ...session.op(), signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
      retryable: false,
    });
  });

  it('stops waiting on an operation once its signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const pending = session.engine.session!.open!(`${session.origin}/never`, { ...session.op(), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
