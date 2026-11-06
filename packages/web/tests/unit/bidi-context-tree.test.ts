/**
 * The browsing-context tree on the BiDi driver: a snapshot taken on connect
 * reconciled with the context events that race it, and the requests of a
 * closed frame, tab, or restarted page retired with every frame in it.
 */

import type { BrowsingContext } from 'webdriver-bidi-protocol';
import { describe, expect, it } from 'vitest';
import { ContextTree } from '../../src/bidi/context-tree.ts';
import { routeEvents } from '../../src/bidi/events.ts';
import { BidiSession } from '../../src/bidi/session.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

/** A context's info, as `getTree` lists it and its events carry it. */
function info(context: string, parent: string | null, children: BrowsingContext.Info[] | null = null): BrowsingContext.Info {
  return { context, userContext: 'mine', parent, url: 'about:blank', children, clientWindow: 'w', originalOpener: null };
}

/** A request from `context` that no event ever finishes. */
function request(context: string, id: string) {
  return {
    context,
    isBlocked: false,
    navigation: null,
    redirectCount: 0,
    timestamp: 0,
    request: { request: id, url: `http://app.test/${id}`, method: 'GET', headers: [], cookies: [], headersSize: 0, bodySize: 0, timings: {} },
  };
}

/** A session of user context `mine` on `fake`, its tab `tab` open, its events routed through a tree that knows `tab` and its frames `frame` and `inner`. */
async function attempt(fake: FakeBidi) {
  fake
    .on('session.subscribe', { result: { subscription: 'subscription' } })
    .on('network.addDataCollector', { result: { collector: 'collector' } })
    .on('browsingContext.getTree', { result: { contexts: [info('tab', null)] } });
  const contexts = new ContextTree();
  const settings = { siteHeaders: () => undefined, holdRequests: false, media: {}, viewport: null, browser: 'chromium', initScripts: { forAttempt: () => [] }, permissions: [] };
  const session = new BidiSession({ connection: fake.connection, exclusive: true } as never, settings as never, { credentials: undefined } as never, contexts);
  session.userContext = 'mine';
  routeEvents(fake.connection, contexts, () => session);
  fake.emit('browsingContext.contextCreated', info('tab', null));
  fake.emit('browsingContext.contextCreated', info('frame', 'tab'));
  fake.emit('browsingContext.contextCreated', info('inner', 'frame'));
  session.context = 'tab';
  await session.network.bind('mine');
  await session.network.addContext('tab');
  await session.network.track();
  return session;
}

/** Waits for the network to go idle, failing the test after two seconds. */
function idle(session: BidiSession): Promise<void> {
  return session.network.waitForIdle(AbortSignal.timeout(2_000));
}

/** Asserts the network stays busy past its idle window. */
async function busy(session: BidiSession): Promise<void> {
  await expect(session.network.waitForIdle(AbortSignal.timeout(700))).rejects.toThrow();
}

describe('ContextTree', () => {
  it('registers a snapshot’s contexts with their frames, keeping events that raced it', async () => {
    const contexts = new ContextTree();
    await contexts.sync(async () => {
      contexts.created('opened', 'mine', null);
      contexts.destroyed('closed');
      return [info('tab', null, [info('frame', null, [info('inner', null)])]), info('closed', null, [info('closed-frame', null)]), info('opened', null)];
    });
    expect(contexts.owner('inner')).toBe('mine');
    expect(contexts.top('inner')).toBe('tab');
    expect([...contexts.subtree('tab')]).toEqual(['tab', 'frame', 'inner']);
    expect(contexts.owner('opened')).toBe('mine');
    expect(contexts.owner('closed')).toBeUndefined();
    expect(contexts.owner('closed-frame')).toBeUndefined();
  });

  it('forgets every frame of a closed context', () => {
    const contexts = new ContextTree();
    contexts.created('tab', 'mine', null);
    contexts.created('frame', undefined, 'tab');
    contexts.created('inner', undefined, 'frame');
    contexts.destroyed('frame');
    expect(contexts.owner('inner')).toBeUndefined();
    expect([...contexts.subtree('tab')]).toEqual(['tab']);
  });
});

describe('request retirement', () => {
  it('stops counting the requests of a frame that closed', async () => {
    const fake = new FakeBidi();
    const session = await attempt(fake);
    fake.emit('network.beforeRequestSent', request('inner', 'stuck'));
    await busy(session);
    fake.emit('browsingContext.contextDestroyed', info('frame', 'tab'));
    await idle(session);
  });

  it('stops counting the requests of every frame in a tab that closed', async () => {
    const fake = new FakeBidi();
    const session = await attempt(fake);
    fake.emit('network.beforeRequestSent', request('frame', 'stuck'));
    fake.emit('network.beforeRequestSent', request('inner', 'stuck-too'));
    await busy(session);
    fake.emit('browsingContext.contextDestroyed', info('tab', null));
    await idle(session);
  });

  it('goes idle after a restart while a frame’s request never finished', async () => {
    const fake = new FakeBidi();
    const session = await attempt(fake);
    fake.emit('network.beforeRequestSent', request('inner', 'stuck'));
    await busy(session);
    await session.closeContext(new AbortController().signal);
    fake.emit('browsingContext.contextCreated', info('next', null));
    session.context = 'next';
    await session.network.addContext('next');
    await idle(session);
  });
});
