/** A screenshot must not edit the form elements a server-rendered app hydrates. */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';
import { BidiConnection } from '../../src/driver/connection.ts';
import { callFunction } from '../../src/driver/script.ts';

let app: FixtureApp;
let session: WebSession;

beforeAll(async () => {
  app = await startFixtureApp();
  session = await startWebSession({ web: { viewport: { width: 320, height: 200 } }, startAttempt: false });
});

beforeEach(async () => {
  await session.startAttempt();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await session.endAttempt();
});

afterAll(async () => {
  await session?.close();
  await app?.close();
});

interface Sample {
  /** The caret color of every editable, light DOM, closed root, and iframe. */
  readonly colors: Record<string, string>;
  /** The constructed stylesheets the main document, the closed root, and the iframe document hold. */
  readonly adopted: [number, number, number];
}

/** Samples the page's editable caret colors and how many sheets each root still holds. Runs in the page. */
function samplePage(): Sample {
  const colors: Record<string, string> = {};
  for (const id of ['plain', 'notes', 'secret']) {
    const element = document.getElementById(id);
    if (element !== null) colors[id] = getComputedStyle(element).caretColor;
  }
  const tracker = (globalThis as unknown as Record<symbol, WeakMap<Element, ShadowRoot> | undefined>)[Symbol.for('e2e.closedShadowRoots')];
  const closed = tracker?.get(document.getElementById('caret-host')!);
  if (closed === undefined) throw new Error('the fixture closed root was not recorded');
  colors['shadowed'] = getComputedStyle(closed.getElementById('shadowed')!).caretColor;
  const frame = document.querySelector('iframe')!.contentDocument!;
  colors['framed'] = getComputedStyle(frame.getElementById('framed')!).caretColor;
  return { colors, adopted: [document.adoptedStyleSheets.length, closed.adoptedStyleSheets.length, frame.adoptedStyleSheets.length] };
}

/** Runs `fn` in the page through the fixture. */
const inPage = <T,>(fn: () => T): Promise<T> => session.browser.evaluate(fn as never) as Promise<T>;

/** Runs `record` with the browsing context of each screenshot the moment before it is taken; `fail` rejects the capture instead. */
function aroundCapture(record: (connection: BidiConnection, context: string) => Promise<void>, fail?: Error): void {
  const send = BidiConnection.prototype.send;
  vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(async function (this: BidiConnection, method, params) {
    if (method === 'browsingContext.captureScreenshot') {
      await record(this, (params as { context: string }).context);
      if (fail !== undefined) throw fail;
    }
    return send.call(this, method, params);
  });
}

/** One agent observation with pixels: the capture that masks fields and hides carets. */
const observeWithPixels = () => session.engine.observe!({ ...session.op(5_000), origin: 'agent' }, { pixels: true });

it('hides every caret while the capture runs and restores each root afterwards', async () => {
  await session.open(`${app.url}/caret`);
  await session.waitForFrames();
  // The main document and the iframe document each watch their own `style`
  // writes, so a hidden write in either one fails the test.
  await inPage(() => {
    const watch = (doc: Document, view: Window) => {
      const into: string[] = [];
      Reflect.set(view, 'styleMutations', into);
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes' && record.attributeName === 'style') into.push((record.target as HTMLElement).id);
        }
      }).observe(doc.documentElement, { subtree: true, attributes: true, attributeFilter: ['style'] });
    };
    watch(document, window);
    const frame = document.querySelector('iframe')!;
    watch(frame.contentDocument!, frame.contentWindow!);
    return null;
  });
  const before = await inPage(samplePage);
  expect(before.colors).toEqual({
    plain: 'rgb(0, 0, 0)',
    notes: 'rgb(0, 0, 0)',
    secret: 'rgb(0, 0, 0)',
    shadowed: 'rgb(255, 0, 0)',
    framed: 'rgb(0, 0, 0)',
  });
  expect(before.adopted).toEqual([0, 0, 0]);
  const during: Sample[] = [];
  aroundCapture(async (connection, context) => {
    during.push((await callFunction(connection, context, samplePage, [], { maxObjectDepth: null })) as unknown as Sample);
  });

  const snapshot = await observeWithPixels();
  vi.restoreAllMocks();

  expect(snapshot.pixels?.width).toBe(320);
  expect(snapshot.maskedRegionCount).toBeGreaterThan(0);
  expect(await inPage(() => [
    Reflect.get(window, 'styleMutations') as string[],
    Reflect.get(document.querySelector('iframe')!.contentWindow!, 'styleMutations') as string[],
  ])).toEqual([[], []]);
  expect(during).toHaveLength(1);
  expect(during[0]!.colors).toEqual({
    plain: 'rgba(0, 0, 0, 0)',
    notes: 'rgba(0, 0, 0, 0)',
    secret: 'rgba(0, 0, 0, 0)',
    shadowed: 'rgba(0, 0, 0, 0)',
    framed: 'rgba(0, 0, 0, 0)',
  });
  expect(during[0]!.adopted).toEqual([1, 1, 1]);
  expect(await inPage(samplePage)).toEqual(before);
});

it('restores every root when the screenshot fails', async () => {
  await session.open(`${app.url}/caret`);
  await session.waitForFrames();
  const before = await inPage(samplePage);
  aroundCapture(async () => undefined, new Error('capture failed'));

  await expect(session.engine.artifacts!.screenshot!('failed', session.op(5_000))).rejects.toThrow('capture failed');
  vi.restoreAllMocks();

  expect(await inPage(samplePage)).toEqual(before);
});

it('hides the caret on a page whose style-src policy blocks style elements', async () => {
  await session.open(`${app.url}/caret-csp`);
  const caretColor = () => getComputedStyle(document.getElementById('plain')!).caretColor;
  // The policy is real: a style element does not apply.
  expect(await inPage(() => {
    const style = document.createElement('style');
    style.textContent = 'input { caret-color: transparent !important; }';
    document.head.append(style);
    return getComputedStyle(document.getElementById('plain')!).caretColor;
  })).toBe('rgb(0, 0, 0)');
  const during: string[] = [];
  aroundCapture(async (connection, context) => {
    during.push((await callFunction(connection, context, caretColor)) as string);
  });

  await observeWithPixels();
  vi.restoreAllMocks();

  expect(during).toEqual(['rgba(0, 0, 0, 0)']);
  expect(await inPage(caretColor)).toBe('rgb(0, 0, 0)');
  expect(await inPage(() => document.adoptedStyleSheets.length)).toBe(0);
});
