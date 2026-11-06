/**
 * The app log: what a page does on its own during an attempt reaches the
 * harness as one line each, from a real browser: console output, exceptions
 * nothing caught, requests that failed, responses with an error status, and
 * where the page went. A console echo of a failed load, a request the page
 * abandoned, and a navigation the engine made itself are left out, so each
 * event is one line. Each action and `open` hands the harness the screen it
 * left, and the attempt says which browser it ran on.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { AppLogEntry, EngineSnapshot } from 'e2e/engine';
import { startWebSession, type WebSession, type WebSessionOptions } from '../helpers/web-session.ts';

const PAGE = `<!doctype html><html><body><h1>Todos</h1><script>
  console.log('ready');
  console.warn('deprecated prop');
  console.error('failed to load todos');
  fetch('/api/todos');
  fetch('/api/missing');
  fetch('/api/reset').catch(() => undefined);
  setTimeout(() => { throw new RangeError('render loop exceeded'); }, 0);
</script></body></html>`;

const MOVING = `<!doctype html><html><body><h1>Moving</h1><button onclick="window.open('/tab', '_blank')">Help</button><script>
  const frame = document.createElement('iframe');
  frame.name = 'pay';
  frame.src = '/embed';
  document.body.append(frame);
  setTimeout(() => { location.href = '/next'; }, 1000);
</script></body></html>`;

/** The pages a navigation lands on, each naming its own path; served from here, never from the request. */
const LANDINGS: Readonly<Record<string, string>> = Object.fromEntries(
  ['/next', '/tab', '/embed'].map((landing) => [landing, `<!doctype html><h1>${landing}</h1>`]),
);

/** Answers one request of the app: its pages, a reset, a server error, and a miss. */
function app(request: IncomingMessage, response: ServerResponse): void {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(PAGE);
  } else if (request.url === '/moving') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(MOVING);
  } else if (request.url !== undefined && Object.hasOwn(LANDINGS, request.url)) {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(LANDINGS[request.url]);
  } else if (request.url === '/api/reset') {
    request.socket.destroy();
  } else if (request.url === '/api/todos') {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{}');
  } else {
    response.writeHead(404);
    response.end();
  }
}

/** Boots a session whose page server answers every app path with `app`. */
async function boot(attempt: NonNullable<WebSessionOptions['attempt']>): Promise<WebSession> {
  const session = await startWebSession({ attempt });
  for (const pathname of ['/', '/moving', ...Object.keys(LANDINGS), '/api/reset', '/api/todos', '/api/missing']) session.serve(pathname, app);
  return session;
}

describe('app log', () => {
  it('reports console output, uncaught exceptions, and error responses, one line each', async () => {
    const entries: AppLogEntry[] = [];
    const session = await boot({ appLog: (entry) => entries.push(entry) });
    const url = session.origin;
    try {
      await session.browser.goto('/');
      await expect.poll(() => entries.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(7);
      expect(entries).toEqual(expect.arrayContaining([
        { source: 'console', level: 'info', text: expect.stringMatching(/^ready/) },
        { source: 'console', level: 'warning', text: expect.stringMatching(/^deprecated prop/) },
        { source: 'console', level: 'error', text: expect.stringMatching(/^failed to load todos/) },
        { source: 'network', level: 'error', text: `GET ${url}/api/todos 500 Internal Server Error` },
        { source: 'network', level: 'warning', text: `GET ${url}/api/missing 404 Not Found` },
        { source: 'error', level: 'error', text: expect.stringMatching(/^RangeError: render loop exceeded/) },
        { source: 'network', level: 'error', text: expect.stringMatching(new RegExp(`^GET ${url}/api/reset net::ERR_`)) },
      ]));
      expect(entries).toHaveLength(7);
      expect(entries.some((entry) => entry.text.startsWith('Failed to load resource'))).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('tells where the page went, apart from its own navigations, the screen each action left, and the browser', async () => {
    const entries: AppLogEntry[] = [];
    const went: string[] = [];
    const screens: EngineSnapshot[] = [];
    const facts: Record<string, string>[] = [];
    const session = await boot({
      appLog: (entry) => entries.push(entry),
      navigation: (line) => went.push(line),
      screen: (snapshot) => screens.push(snapshot),
      environment: (told) => facts.push({ ...told }),
    });
    const url = session.origin;
    const operation = () => session.op();
    try {
      await session.open(`${url}/moving`);
      expect(screens).toHaveLength(1);
      expect(screens[0]!.location).toBe(`${url}/moving`);
      // The screen is the trace's, never published: a ref from the observation acts after it, twice.
      const observed = await session.observe();
      const help = observed.root.children?.find((node) => node.role === 'button');
      await session.engine.perform!(help!.ref, { kind: 'tap' }, operation());
      await session.engine.perform!(help!.ref, { kind: 'tap' }, operation());
      expect(screens).toHaveLength(3);
      const navigations = () => [...went];
      await expect.poll(navigations, { timeout: 5_000 }).toContain(`navigated to ${url}/next`);
      expect(navigations()).toEqual(expect.arrayContaining([
        expect.stringMatching(new RegExp(`^frame .*loaded ${url}/embed$`)),
        expect.stringMatching(/^the app opened a new tab.*; the test stays on its page$/),
      ]));
      expect(navigations().some((text) => text.includes('/moving'))).toBe(false);
      expect(navigations().some((text) => text.startsWith('the new tab navigated'))).toBe(false);
      await expect.poll(() => facts.length, { timeout: 5_000 }).toBe(1);
      expect(facts[0]).toEqual({ browser: expect.stringMatching(/^chromium \S+$/), driver: 'webdriver-bidi' });
    } finally {
      await session.close();
    }
  });

  // Missing in BiDi: console lines carry no source location suffix (" (at <url>:<line>)").
  it.skip('names where each console line came from', async () => {
    const entries: AppLogEntry[] = [];
    const session = await boot({ appLog: (entry) => entries.push(entry) });
    try {
      await session.browser.goto('/');
      await expect.poll(() => entries.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(7);
      expect(entries).toEqual(expect.arrayContaining([
        { source: 'console', level: 'info', text: expect.stringMatching(/^ready \(at /) },
        { source: 'console', level: 'warning', text: expect.stringMatching(/^deprecated prop \(at http:\/\/127\.0\.0\.1:\d+\/:\d+\)$/) },
        { source: 'console', level: 'error', text: expect.stringMatching(/^failed to load todos /) },
      ]));
    } finally {
      await session.close();
    }
  });

  // Missing in BiDi: navigation lines leave out the frame's name and the new tab's URL, and a tab is told twice.
  it.skip('names the frame that loaded and the URL of the tab the app opened, once', async () => {
    const went: string[] = [];
    const session = await boot({ navigation: (line) => went.push(line) });
    const url = session.origin;
    try {
      await session.open(`${url}/moving`);
      const help = (await session.observe()).root.children?.find((node) => node.role === 'button');
      await session.engine.perform!(help!.ref, { kind: 'tap' }, session.op());
      await expect.poll(() => [...went], { timeout: 5_000 }).toContain(`navigated to ${url}/next`);
      expect(went).toEqual(expect.arrayContaining([
        `frame "pay" loaded ${url}/embed`,
        `the app opened a new tab at ${url}/tab; the test stays on its page`,
      ]));
      expect(went.filter((line) => line.startsWith('the app opened a new tab'))).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  // Missing in BiDi: the headless shell's environment fact names a revision hash, not a version number.
  it.skip('names the browser by its version number', async () => {
    const facts: Record<string, string>[] = [];
    const session = await boot({ environment: (told) => facts.push({ ...told }) });
    try {
      expect(facts[0]?.['browser']).toMatch(/^chromium \d+\./);
    } finally {
      await session.close();
    }
  });
});
