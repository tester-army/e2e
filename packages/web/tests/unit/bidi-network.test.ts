/**
 * One attempt's network on the BiDi driver against a scripted peer:
 * intercepts scoped to the attempt's tabs, routes newest first with
 * fallback, site headers, failures on unawaited paths, basic-auth answers,
 * the `networkidle` window, and response waits.
 */

import { describe, expect, it } from 'vitest';
import { ContextTree } from '../../src/bidi/context-tree.ts';
import { AttemptNetwork, type NetworkRoute } from '../../src/bidi/network.ts';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';

const SITE = 'http://app.test';

/** An attempt network over `fake`, and the failures it latched. */
function network(
  fake: FakeBidi,
  options: { holdAll?: boolean; credentials?: { username: string; password: string }; browser?: 'chromium' | 'firefox'; exclusive?: boolean; ours?: (context: string | null) => boolean; onPage?: (context: string | null) => boolean } = {},
) {
  const failures: Error[] = [];
  const contexts = new ContextTree();
  let intercepts = 0;
  fake.on('network.addIntercept', () => ({ result: { intercept: `intercept-${(intercepts += 1)}` } }));
  fake.on('network.addDataCollector', { result: { collector: 'collector-1' } });
  fake.on('session.subscribe', { result: { subscription: 'subscription-1' } });
  const net = new AttemptNetwork(fake.connection, {
    siteHeaders: (url) => (new URL(url).origin === new URL(SITE).origin ? { 'x-preview': 'token' } : undefined),
    credentials: options.credentials,
    ours: (event) => options.ours?.(event.context) ?? true,
    onPage: (context) => options.onPage?.(context) ?? true,
    contexts,
    exclusive: options.exclusive ?? false,
    browser: options.browser ?? 'chromium',
    onFailure: (error) => failures.push(error),
    onNavigationAbort: () => undefined,
    holdAll: options.holdAll ?? false,
  });
  /** Opens top-level tab `tab` of user-1, as its `contextCreated` event records it, and hands it to the network. */
  const open = (tab: string): Promise<void> => {
    contexts.created(tab, 'user-1', null);
    return net.addContext(tab);
  };
  /** Closes `tab`, as its `contextDestroyed` event tells the network and then the tree. */
  const close = (tab: string): Promise<void> => {
    const removed = net.removeContext(tab);
    contexts.destroyed(tab);
    return removed;
  };
  return { net, failures, contexts, open, close };
}

/** A `beforeRequestSent` event held by `intercepts`. */
function request(id: string, url: string, intercepts: string[] = ['intercept-1']): Record<string, unknown> {
  return {
    context: 'tab',
    isBlocked: intercepts.length > 0,
    navigation: null,
    redirectCount: 0,
    timestamp: 0,
    intercepts,
    request: { request: id, url, method: 'GET', headers: [{ name: 'Accept', value: { type: 'string', value: '*/*' } }], cookies: [], headersSize: 0, bodySize: 0, timings: {} },
  };
}

/** A route on the URL `pattern` for the tests. */
function route(pattern: string, handle: NetworkRoute['handle']): NetworkRoute {
  return { pattern: { kind: 'string', value: pattern, exact: true }, handle };
}

describe('AttemptNetwork', () => {
  it('holds requests only for the attempt’s tabs, and starts over on a new user context', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { holdAll: true });
    await net.bind('user-1');
    expect(fake.commands('network.addIntercept')).toEqual([]);
    await open('tab-1');
    await open('tab-2');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([
      { phases: ['beforeRequestSent'], contexts: ['tab-1'] },
      { phases: ['beforeRequestSent'], contexts: ['tab-1', 'tab-2'] },
    ]);
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1']);
    await net.bind('user-2');
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept']).slice(1).toSorted()).toEqual(['intercept-1', 'intercept-2']);
    expect(fake.commands('session.subscribe').at(-1)?.params).toEqual({ events: ['network.beforeRequestSent', 'network.authRequired'], userContexts: ['user-2'] });
  });

  it('runs the newest matching route first and passes a fallback to the next', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    const order: string[] = [];
    await net.addRoute(route('**', async (_request, decisions) => {
      order.push('older');
      await decisions.fulfill({ status: 201, headers: {}, json: [{ name: 'Stubbed' }] });
    }));
    await net.addRoute(route('**/api/users', async (_request, decisions) => {
      order.push('newer');
      await decisions.fallback();
    }));
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/api/users`));
    await settle();
    await settle();
    expect(order).toEqual(['newer', 'older']);
    expect(fake.commands('network.provideResponse')[0]?.params).toEqual({
      request: 'r1',
      statusCode: 201,
      reasonPhrase: 'Created',
      headers: [{ name: 'content-type', value: { type: 'string', value: 'application/json' } }, { name: 'content-length', value: { type: 'string', value: '20' } }],
      body: { type: 'base64', value: Buffer.from('[{"name":"Stubbed"}]').toString('base64') },
    });
  });

  it('lets an unmatched request through, adding the site headers only for the app’s site', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { holdAll: true });
    await net.bind('user-1');
    await open('tab');
    fake.emit('network.beforeRequestSent', request('site', `${SITE}/page`));
    fake.emit('network.beforeRequestSent', request('other', 'https://cdn.test/lib.js'));
    await settle();
    const continued = fake.commands('network.continueRequest').map((command) => command.params);
    expect(continued).toContainEqual({
      request: 'site',
      headers: [{ name: 'accept', value: { type: 'string', value: '*/*' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }],
    });
    expect(continued).toContainEqual({ request: 'other' });
  });

  it('releases a held request whose route failed and reports the failure, but not a request the page already dropped', async () => {
    const fake = new FakeBidi();
    const { net, failures, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.addRoute(route('**', async () => {
      throw new Error('handler exploded');
    }));
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/a`));
    await settle();
    await settle();
    expect(fake.commands('network.failRequest').map((command) => command.params)).toEqual([{ request: 'r1' }]);
    expect(failures.map((error) => error.message)).toEqual(['handler exploded']);
    await net.removeRoutes(() => true);
    fake.on('network.continueRequest', { error: 'no such request', message: 'gone' });
    fake.emit('network.beforeRequestSent', request('r2', `${SITE}/b`));
    await settle();
    await settle();
    expect(failures).toHaveLength(1);
  });

  it('answers a basic-auth challenge once, then lets a refused one through as the 401', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { credentials: { username: 'ada', password: 'secret' } });
    await net.bind('user-1');
    await open('tab');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toContainEqual({ phases: ['authRequired'], contexts: ['tab'] });
    const challenge = { ...request('r1', `${SITE}/private`), response: { status: 401 } };
    fake.emit('network.authRequired', challenge);
    fake.emit('network.authRequired', challenge);
    await settle();
    expect(fake.commands('network.continueWithAuth').map((command) => command.params)).toEqual([
      { request: 'r1', action: 'provideCredentials', credentials: { type: 'password', username: 'ada', password: 'secret' } },
      { request: 'r1', action: 'cancel' },
    ]);
  });

  it('holds challenges on Firefox without credentials and lets each through as the 401', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { browser: 'firefox' });
    await net.bind('user-1');
    await open('tab');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([{ phases: ['authRequired'], contexts: ['tab'] }]);
    fake.emit('network.authRequired', { ...request('r1', `${SITE}/private`), response: { status: 401 } });
    await settle();
    expect(fake.commands('network.continueWithAuth').map((command) => command.params)).toEqual([{ request: 'r1', action: 'cancel' }]);
  });

  it('holds no challenge on Chromium without credentials', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    expect(fake.commands('network.addIntercept')).toEqual([]);
  });

  it('refuses a URL rewrite on Firefox before the request goes, and fails the request', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { browser: 'firefox' });
    const errors: unknown[] = [];
    await net.bind('user-1');
    await net.addRoute(route(`${SITE}/a`, (_request, decisions) => decisions.continue({ url: `${SITE}/other` }).catch((cause: unknown) => {
      errors.push(cause);
      throw cause;
    })));
    await open('tab');
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/a`));
    await settle();
    expect(errors).toEqual([expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' })]);
    expect(fake.commands('network.continueRequest')).toEqual([]);
    expect(fake.commands('network.failRequest').map((command) => command.params)).toEqual([{ request: 'r1' }]);
  });

  it('waits for 500 ms with no request in flight before calling the network idle', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    await net.track();
    fake.emit('network.beforeRequestSent', request('r1', `${SITE}/slow`, []));
    const started = Date.now();
    let idle = false;
    const waiting = net.waitForIdle(AbortSignal.timeout(5_000)).then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(idle).toBe(false);
    fake.emit('network.responseCompleted', { ...request('r1', `${SITE}/slow`, []), response: { url: `${SITE}/slow`, status: 200 } });
    await waiting;
    expect(Date.now() - started).toBeGreaterThanOrEqual(690);
  });

  it('resolves a response wait on the headers of the first match in the tab, and reads its body once loaded', async () => {
    const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: '[1,2,3]' } } });
    const { net } = network(fake, { onPage: (context) => context === 'tab' });
    await net.bind('user-1');
    const waiting = net.waitForResponse((url) => url.endsWith('/api/users'), AbortSignal.timeout(5_000));
    await settle();
    const started = (id: string, url: string, context = 'tab') => ({
      ...request(id, url, []),
      context,
      response: { url, status: 200, headers: [{ name: 'Content-Type', value: { type: 'string', value: 'application/json' } }] },
    });
    fake.emit('network.responseStarted', started('other', `${SITE}/other`));
    fake.emit('network.responseStarted', started('popup', `${SITE}/api/users`, 'popup'));
    fake.emit('network.responseStarted', started('users', `${SITE}/api/users`));
    const response = await waiting;
    expect(response).toMatchObject({ url: `${SITE}/api/users`, status: 200, headers: { 'content-type': 'application/json' } });
    let read = false;
    const body = response.body().then((bytes) => {
      read = true;
      return bytes.toString();
    });
    await settle();
    expect(read).toBe(false);
    fake.emit('network.responseCompleted', started('users', `${SITE}/api/users`));
    await expect(body).resolves.toBe('[1,2,3]');
    expect(fake.commands('network.getData')[0]?.params).toEqual({ dataType: 'response', request: 'users', collector: 'collector-1', disown: true });
  });

  it('rejects a body read with the browser’s error when the load failed', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.responseStarted', { ...request('cut', `${SITE}/cut`, []), response: { url: `${SITE}/cut`, status: 200, headers: [] } });
    const response = await waiting;
    fake.emit('network.fetchError', { ...request('cut', `${SITE}/cut`, []), errorText: 'net::ERR_CONTENT_LENGTH_MISMATCH' });
    await expect(response.body()).rejects.toThrow('net::ERR_CONTENT_LENGTH_MISMATCH');
  });

  it('adds one response collector for concurrent waits', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const first = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    const second = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    fake.emit('network.responseStarted', { ...request('r', `${SITE}/r`, []), response: { url: `${SITE}/r`, status: 200, headers: [] } });
    await Promise.all([first, second]);
    expect(fake.commands('network.addDataCollector')).toHaveLength(1);
    await net.bind('user-2');
    expect(fake.commands('network.removeDataCollector')).toHaveLength(1);
  });

  it('on a browser of its own, holds every tab with one intercept and lets another user context’s requests go untouched', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { holdAll: true, exclusive: true, ours: (context) => context !== 'foreign' });
    await net.bind('user-1');
    await open('tab-1');
    await open('tab-2');
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([{ phases: ['beforeRequestSent'] }]);
    fake.emit('network.beforeRequestSent', { ...request('popup', `${SITE}/popup`), context: 'popup' });
    fake.emit('network.beforeRequestSent', { ...request('foreign', `${SITE}/x`), context: 'foreign' });
    await settle();
    expect(fake.commands('network.continueRequest').map((command) => command.params)).toEqual([
      { request: 'popup', headers: [{ name: 'accept', value: { type: 'string', value: '*/*' } }, { name: 'x-preview', value: { type: 'string', value: 'token' } }] },
      { request: 'foreign' },
    ]);
  });

  it('decides a request an intercept it since replaced still holds', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { holdAll: true });
    await net.bind('user-1');
    await open('tab-1');
    await open('tab-2');
    fake.emit('network.beforeRequestSent', request('held', `${SITE}/held`, ['intercept-1']));
    await settle();
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['held']);
  });

  it('answers a blank-served tab’s documents before any route, and fails its other requests', async () => {
    const fake = new FakeBidi();
    const { net, contexts } = network(fake);
    await net.bind('user-1');
    let routed = 0;
    await net.addRoute(route('**', async () => {
      routed += 1;
    }));
    contexts.created('scratch', 'user-1', null);
    const undo = await net.serveBlank('scratch');
    fake.emit('network.beforeRequestSent', { ...request('doc', `${SITE}/`), context: 'scratch', navigation: 'nav-1' });
    fake.emit('network.beforeRequestSent', { ...request('img', `${SITE}/a.png`), context: 'scratch' });
    await settle();
    expect(routed).toBe(0);
    expect(fake.commands('network.provideResponse').map((command) => command.params['request'])).toEqual(['doc']);
    expect(fake.commands('network.failRequest').map((command) => command.params['request'])).toEqual(['img']);
    await undo();
    fake.emit('network.beforeRequestSent', { ...request('later', `${SITE}/`), context: 'scratch', navigation: 'nav-2' });
    await settle();
    expect(routed).toBe(1);
  });

  it('reads the body of a response whose load completes in the same burst as its headers', async () => {
    const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'fast' } } });
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    const event = { ...request('fast', `${SITE}/fast`, []), response: { url: `${SITE}/fast`, status: 200, headers: [] } };
    fake.emit('network.responseStarted', event);
    fake.emit('network.responseCompleted', event);
    const response = await waiting;
    await expect(response.body().then(String)).resolves.toBe('fast');
  });

  it('marks a held request body the browser did not keep, so it is never replayed empty', async () => {
    const fake = new FakeBidi().on('network.getData', () => ({ error: 'no such network data', message: 'evicted' }));
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    let seen: unknown;
    await net.addRoute(route('**', async (held, decisions) => {
      seen = held;
      await decisions.continue({});
    }));
    const posted = request('post', `${SITE}/upload`);
    fake.emit('network.beforeRequestSent', { ...posted, request: { ...(posted['request'] as object), method: 'POST', bodySize: 30_000_000 } });
    await settle();
    expect(seen).toMatchObject({ bodyUnavailable: true });
  });

  it('never covers a tab that opened and closed in the same burst, nor one that closed while its intercept was added', async () => {
    const fake = new FakeBidi();
    const { net, open, close } = network(fake, { holdAll: true });
    let intercepts = 0;
    fake.on('network.addIntercept', (params) => {
      if ((params['contexts'] as string[]).includes('popup')) {
        void close('popup');
        return { error: 'no such frame', message: 'gone' };
      }
      return { result: { intercept: `intercept-${(intercepts += 1)}` } };
    });
    await net.bind('user-1');
    void open('flash');
    await close('flash');
    expect(fake.commands('network.addIntercept')).toEqual([]);
    await open('tab');
    await open('popup');
    expect(fake.commands('network.addIntercept').map((command) => command.params['contexts'])).toEqual([['tab'], ['tab', 'popup'], ['tab']]);
  });

  it('calls the network idle while a tab the app opened is still busy', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake, { onPage: (context) => context === 'tab' });
    await net.bind('user-1');
    await net.track();
    fake.emit('network.beforeRequestSent', { ...request('poll', `${SITE}/poll`, []), context: 'popup' });
    const started = Date.now();
    await net.waitForIdle(AbortSignal.timeout(5_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports a removal the browser refused, and takes one it no longer has as done', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { holdAll: true, exclusive: true });
    fake.on('network.addIntercept', { result: { intercept: 'global' } });
    await net.bind('user-1');
    await open('tab');
    fake.on('network.removeIntercept', { error: 'unknown error', message: 'refused' });
    await expect(net.dispose()).rejects.toThrow('refused');
    const again = new FakeBidi();
    const { net: second, open: secondOpen } = network(again, { holdAll: true, exclusive: true });
    again.on('network.addIntercept', { result: { intercept: 'global' } });
    await second.bind('user-1');
    await secondOpen('tab');
    again.on('network.removeIntercept', { error: 'no such intercept', message: 'gone' });
    await expect(second.dispose()).resolves.toBeUndefined();
  });

  it('removes a replacement intercept whose predecessor would not go, when the network is released', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { holdAll: true });
    await net.bind('user-1');
    await open('tab-1');
    fake.on('network.removeIntercept', (params) => (params['intercept'] === 'intercept-1' ? { error: 'unknown error', message: 'stuck' } : { result: {} }));
    await expect(open('tab-2')).rejects.toThrow('stuck');
    fake.on('network.removeIntercept', { result: {} });
    await net.dispose();
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toContain('intercept-2');
  });

  describe('redirect hops and the site headers', () => {
    /** The `x-preview` header and the route's own on a redirect hop's continue, or undefined when it went on untouched. */
    async function hop(fake: FakeBidi, id: string, url: string, count: number, carried: Record<string, string>): Promise<Record<string, string> | undefined> {
      const base = request(id, url);
      const headers = Object.entries({ Accept: '*/*', ...carried }).map(([name, value]) => ({ name, value: { type: 'string', value } }));
      fake.emit('network.beforeRequestSent', { ...base, redirectCount: count, request: { ...(base['request'] as object), headers } });
      await settle();
      await settle();
      const sent = fake.commands('network.continueRequest').at(-1)?.params;
      if (sent?.['request'] !== id) throw new Error(`no continue for ${id}`);
      const wire = sent['headers'] as { name: string; value: { value: string } }[] | undefined;
      return wire === undefined ? undefined : Object.fromEntries(wire.map((header) => [header.name, header.value.value]));
    }

    it('adds the site headers to every hop on the site and to none off it, for a request no route matched', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { holdAll: true });
      await net.bind('user-1');
      await open('tab');
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/start`));
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params['headers']).toContainEqual({ name: 'x-preview', value: { type: 'string', value: 'token' } });
      expect(await hop(fake, 'r', `${SITE}/next`, 1, {})).toEqual({ accept: '*/*', 'x-preview': 'token' });
      expect(await hop(fake, 'r', 'https://external.test/end', 2, { 'x-preview': 'token' })).toEqual({ accept: '*/*' });
      expect(await hop(fake, 'r', 'https://external.test/again', 3, {})).toBeUndefined();
      expect(await hop(fake, 'r', `${SITE}/back`, 4, {})).toEqual({ accept: '*/*', 'x-preview': 'token' });
      expect(await hop(fake, 'r', 'https://external.test/last', 5, { 'x-preview': 'token' })).toEqual({ accept: '*/*' });
    });

    it('applies a route’s header overrides to every hop, and the site headers only to hops on the site', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (held, decisions) => {
        await decisions.continue({ headers: { ...held.headers, 'X-Route': 'routed' } });
      }));
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/start`));
      await settle();
      await settle();
      expect(await hop(fake, 'r', `${SITE}/next`, 1, {})).toEqual({ accept: '*/*', 'x-route': 'routed', 'x-preview': 'token' });
      expect(await hop(fake, 'r', 'https://external.test/end', 2, { 'x-preview': 'token', 'x-route': 'routed' })).toEqual({ accept: '*/*', 'x-route': 'routed' });
      expect(await hop(fake, 'r', `${SITE}/back`, 3, {})).toEqual({ accept: '*/*', 'x-route': 'routed', 'x-preview': 'token' });
    });

    it('sends nothing of the site’s to a request that starts off the site and redirects there and away again', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { holdAll: true });
      await net.bind('user-1');
      await open('tab');
      fake.emit('network.beforeRequestSent', request('r', 'https://external.test/start'));
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params).toEqual({ request: 'r' });
      expect(await hop(fake, 'r', `${SITE}/in`, 1, {})).toEqual({ accept: '*/*', 'x-preview': 'token' });
      expect(await hop(fake, 'r', 'https://external.test/out', 2, { 'x-preview': 'token' })).toEqual({ accept: '*/*' });
    });
  });

  it('calls a new user context idle while a request of the one it replaced never finished', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    await net.track();
    fake.emit('network.beforeRequestSent', request('stuck', `${SITE}/stuck`, []));
    await net.bind('user-2');
    await net.track();
    const started = Date.now();
    await net.waitForIdle(AbortSignal.timeout(2_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops counting the requests of a tab that closed without their events', async () => {
    const fake = new FakeBidi();
    const { net, open, close } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.track();
    fake.emit('network.beforeRequestSent', request('stuck', `${SITE}/stuck`, []));
    await close('tab');
    await net.waitForIdle(AbortSignal.timeout(2_000));
  });

  it.each([
    ['the subscription', 'session.subscribe'],
    ['the request collector', 'network.addDataCollector'],
    ['the intercept', 'network.addIntercept'],
  ])('takes a route back when %s fails to install, and installs everything on the next try', async (_step, method) => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    let failed = false;
    let intercepts = 0;
    const answers: Record<string, (params: Record<string, unknown>) => { result: unknown }> = {
      'session.subscribe': () => ({ result: { subscription: 'subscription-1' } }),
      'network.addDataCollector': () => ({ result: { collector: 'collector-2' } }),
      'network.addIntercept': () => ({ result: { intercept: `intercept-${(intercepts += 1)}` } }),
    };
    fake.on(method, (params) => {
      const ours = method !== 'network.addDataCollector' || (params['dataTypes'] as string[]).includes('request');
      if (ours && !failed) {
        failed = true;
        return { error: 'unknown error', message: 'install failed' };
      }
      return answers[method]!(params);
    });
    const handled: string[] = [];
    await expect(net.addRoute(route('**', async (_held, decisions) => {
      handled.push('first');
      await decisions.continue({});
    }))).rejects.toThrow('install failed');
    await net.addRoute(route('**', async (_held, decisions) => {
      handled.push('second');
      await decisions.fallback();
    }));
    expect(fake.commands('session.subscribe')).toHaveLength(method === 'session.subscribe' ? 2 : 1);
    expect(fake.commands('network.addDataCollector').filter((command) => (command.params['dataTypes'] as string[]).includes('request'))).toHaveLength(method === 'network.addDataCollector' ? 2 : 1);
    expect(fake.commands('network.addIntercept').map((command) => command.params)).toEqual([
      ...(method === 'network.addIntercept' ? [{ phases: ['beforeRequestSent'], contexts: ['tab'] }] : []),
      { phases: ['beforeRequestSent'], contexts: ['tab'] },
    ]);
    fake.emit('network.beforeRequestSent', request('r', `${SITE}/a`));
    await settle();
    await settle();
    expect(handled).toEqual(['second']);
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['r']);
  });

  describe('a response body still loading', () => {
    /** A network bound to user-1, and a response whose headers arrived but whose body never finished. */
    async function pending() {
      const fake = new FakeBidi();
      const { net } = network(fake);
      await net.bind('user-1');
      const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.responseStarted', { ...request('r', `${SITE}/r`, []), response: { url: `${SITE}/r`, status: 200, headers: [] } });
      return { fake, net, response: await waiting };
    }

    it('fails its read once the network is disposed', async () => {
      const { net, response } = await pending();
      await net.dispose();
      await expect(response.body()).rejects.toThrow('the network ended before the response finished loading');
    });

    it('fails a read already waiting when the network is disposed', async () => {
      const { net, response } = await pending();
      const body = response.body();
      await net.dispose();
      await expect(body).rejects.toThrow('the network ended');
    });

    it('fails its read once the user context is replaced', async () => {
      const { net, response } = await pending();
      await net.bind('user-2');
      await expect(response.body()).rejects.toThrow('the network ended');
    });

    it('fails its read once the connection closes', async () => {
      const { fake, response } = await pending();
      fake.drop();
      await expect(response.body()).rejects.toThrow('the BiDi connection closed');
    });
  });

  it('keeps a removal that failed while rebinding, and tries it again on dispose', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { holdAll: true, exclusive: true });
    fake.on('network.addIntercept', { result: { intercept: 'global' } });
    await net.bind('user-1');
    await open('tab');
    fake.on('network.removeIntercept', { error: 'unknown error', message: 'stuck' });
    await expect(net.bind('user-2')).rejects.toThrow('stuck');
    fake.on('network.removeIntercept', { result: {} });
    await net.dispose();
    expect(fake.commands('network.removeIntercept').filter((command) => command.params['intercept'] === 'global').length).toBeGreaterThanOrEqual(2);
  });

  describe('what a request leaves behind once it is over', () => {
    it('forgets a basic-auth answer once its tab closed mid-redirect, so a new challenge gets the credentials', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake, { credentials: { username: 'ada', password: 'secret' } });
      await net.bind('user-1');
      await open('tab');
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/private`, []));
      fake.emit('network.authRequired', { ...request('r', `${SITE}/private`), response: { status: 401 } });
      fake.emit('network.responseCompleted', { ...request('r', `${SITE}/private`, []), response: { url: `${SITE}/private`, status: 302, headers: [] } });
      net.retire('tab');
      fake.emit('network.authRequired', { ...request('r', `${SITE}/private`), response: { status: 401 } });
      await settle();
      expect(fake.commands('network.continueWithAuth').map((command) => command.params['action'])).toEqual(['provideCredentials', 'provideCredentials']);
    });

    it('forgets a redirect policy once its tab closed mid-redirect', async () => {
      const fake = new FakeBidi();
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (held, decisions) => {
        await decisions.continue({ headers: { ...held.headers, 'x-route': 'routed' } });
      }));
      fake.emit('network.beforeRequestSent', request('r', 'https://external.test/start'));
      await settle();
      await settle();
      fake.emit('network.responseCompleted', { ...request('r', 'https://external.test/start', []), response: { url: 'https://external.test/start', status: 302, headers: [] } });
      net.retire('tab');
      fake.emit('network.beforeRequestSent', { ...request('r', 'https://external.test/again'), redirectCount: 1 });
      await settle();
      expect(fake.commands('network.continueRequest').at(-1)?.params).toEqual({ request: 'r' });
    });

    it('keeps a fulfilled body only until its response completed', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'from the collector' } } });
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**', async (_held, decisions) => {
        await decisions.fulfill({ status: 200, headers: {}, body: 'fulfilled' });
      }));
      const response = (id: string) => ({ ...request(id, `${SITE}/a`, []), response: { url: `${SITE}/a`, status: 200, headers: [] } });
      const first = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.beforeRequestSent', request('r', `${SITE}/a`));
      await settle();
      await settle();
      fake.emit('network.responseStarted', response('r'));
      fake.emit('network.responseCompleted', response('r'));
      await expect((await first).body().then(String)).resolves.toBe('fulfilled');
      await net.removeRoutes(() => true);
      const again = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.responseStarted', response('r'));
      fake.emit('network.responseCompleted', response('r'));
      await expect((await again).body().then(String)).resolves.toBe('from the collector');
    });
  });

  it('adds no intercept for a tab that closed while its intercept was added, and leaves no failure behind', async () => {
    const fake = new FakeBidi();
    const { net, failures, close, contexts } = network(fake, { holdAll: true });
    fake.on('network.addIntercept', (params) => {
      if ((params['contexts'] as string[]).length === 0) return { error: 'invalid argument', message: 'contexts must not be empty' };
      void close('tab');
      return { error: 'no such frame', message: 'gone' };
    });
    await net.bind('user-1');
    contexts.created('tab', 'user-1', null);
    await expect(net.addContext('tab')).resolves.toBeUndefined();
    expect(fake.commands('network.addIntercept').map((command) => command.params['contexts'])).toEqual([['tab']]);
    expect(failures).toEqual([]);
  });

  it('removes a route in call order with an addition still queued behind a tab change', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake, { holdAll: true });
    let release: () => void = () => undefined;
    let intercepts = 0;
    fake.on('network.addIntercept', async () => {
      intercepts += 1;
      if (intercepts === 1) await new Promise<void>((resolve) => (release = resolve));
      return { result: { intercept: `intercept-${intercepts}` } };
    });
    await net.bind('user-1');
    const opening = open('tab');
    let ran = false;
    const removed = route('**', async (_held, decisions) => {
      ran = true;
      await decisions.fulfill({ status: 200, headers: {} });
    });
    const added = net.addRoute(removed);
    const unrouted = net.removeRoutes((one) => one === removed);
    await settle();
    release();
    await Promise.all([opening, added, unrouted]);
    fake.emit('network.beforeRequestSent', request('r', `${SITE}/x`));
    await settle();
    await settle();
    expect(ran).toBe(false);
    expect(fake.commands('network.continueRequest').map((command) => command.params['request'])).toEqual(['r']);
  });

  it('lets interception go once the last route or blank-served tab no longer needs it', async () => {
    const fake = new FakeBidi();
    const { net, open, contexts } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.addRoute(route('**', async (_held, decisions) => decisions.fallback()));
    expect(fake.commands('network.addIntercept')).toHaveLength(1);
    expect(fake.commands('network.addDataCollector').filter((command) => (command.params['dataTypes'] as string[]).includes('request'))).toHaveLength(1);
    await net.removeRoutes(() => true);
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1']);
    expect(fake.commands('network.removeDataCollector')).toHaveLength(1);
    contexts.created('scratch', 'user-1', null);
    const undo = await net.serveBlank('scratch');
    expect(fake.commands('network.addIntercept').at(-1)?.params).toEqual({ phases: ['beforeRequestSent'], contexts: ['tab', 'scratch'] });
    await undo();
    expect(fake.commands('network.removeIntercept').map((command) => command.params['intercept'])).toEqual(['intercept-1', 'intercept-2']);
  });

  it('leaves cookie headers out of a response wait', async () => {
    const fake = new FakeBidi();
    const { net } = network(fake);
    await net.bind('user-1');
    const waiting = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
    await settle();
    const headers = [
      { name: 'Set-Cookie', value: { type: 'string', value: 'sid=secret; HttpOnly' } },
      { name: 'Content-Type', value: { type: 'string', value: 'text/plain' } },
    ];
    fake.emit('network.responseStarted', { ...request('r', `${SITE}/login`, []), response: { url: `${SITE}/login`, status: 200, headers } });
    expect((await waiting).headers).toEqual({ 'content-type': 'text/plain' });
  });

  it('fulfills with the body’s own length, without the encoding headers of the response it amends', async () => {
    const fake = new FakeBidi();
    const { net, open } = network(fake);
    await net.bind('user-1');
    await open('tab');
    await net.addRoute(route('**', async (_held, decisions) => {
      await decisions.fulfill({ status: 200, headers: { 'Content-Encoding': 'gzip', 'Content-Length': '42', 'Content-Type': 'text/plain' }, body: 'decoded body' });
    }));
    fake.emit('network.beforeRequestSent', request('r', `${SITE}/gz`));
    await settle();
    await settle();
    const sent = fake.commands('network.provideResponse')[0]?.params['headers'] as { name: string; value: { value: string } }[];
    expect(Object.fromEntries(sent.map((header) => [header.name, header.value.value]))).toEqual({ 'content-type': 'text/plain', 'content-length': '12' });
  });

  describe('collected bodies', () => {
    it('lets the collector go of a response body no wait matched, and of a body a wait read', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'read' } } });
      const { net } = network(fake);
      await net.bind('user-1');
      const done = (id: string, status = 200) => ({ ...request(id, `${SITE}/${id}`, []), response: { url: `${SITE}/${id}`, status, headers: [] } });
      fake.emit('network.responseCompleted', done('asset'));
      fake.emit('network.responseCompleted', done('hop', 302));
      const waiting = net.waitForResponse((url) => url.endsWith('/waited'), AbortSignal.timeout(5_000));
      await settle();
      fake.emit('network.responseStarted', done('waited'));
      fake.emit('network.responseCompleted', done('waited'));
      const response = await waiting;
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'asset' }]);
      await expect(Promise.all([response.body(), response.body()]).then((bodies) => bodies.map(String))).resolves.toEqual(['read', 'read']);
      expect(fake.commands('network.getData').map((command) => command.params)).toEqual([{ dataType: 'response', collector: 'collector-1', request: 'waited', disown: true }]);
    });

    it('reads a body two waits matched once, for both', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'shared' } } });
      const { net } = network(fake);
      await net.bind('user-1');
      const first = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      const second = net.waitForResponse(() => true, AbortSignal.timeout(5_000));
      await settle();
      const event = { ...request('r', `${SITE}/r`, []), response: { url: `${SITE}/r`, status: 200, headers: [] } };
      fake.emit('network.responseStarted', event);
      fake.emit('network.responseCompleted', event);
      const bodies = await Promise.all([first, second].map(async (wait) => String(await (await wait).body())));
      expect(bodies).toEqual(['shared', 'shared']);
      expect(fake.commands('network.getData')).toHaveLength(1);
      expect(fake.commands('network.disownData')).toEqual([]);
    });

    it('lets the request collector go of a held request’s body once the request is over', async () => {
      const fake = new FakeBidi().on('network.getData', { result: { bytes: { type: 'string', value: 'a=1' } } });
      const { net, open } = network(fake);
      await net.bind('user-1');
      await open('tab');
      await net.addRoute(route('**/api', async (_held, decisions) => decisions.continue({})));
      const posted = request('post', `${SITE}/form`);
      const post = { ...posted, request: { ...(posted['request'] as object), method: 'POST', bodySize: 3 } };
      fake.emit('network.beforeRequestSent', post);
      await settle();
      fake.emit('network.responseCompleted', { ...post, response: { url: `${SITE}/form`, status: 200, headers: [] } });
      await settle();
      expect(fake.commands('network.disownData').map((command) => command.params)).toContainEqual({ dataType: 'request', collector: 'collector-1', request: 'post' });
    });
  });
});
