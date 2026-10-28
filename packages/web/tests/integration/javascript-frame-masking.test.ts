/** Real masking across JavaScript-URL document replacement, including nested roots. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import type { PlaywrightSurface } from '../../src/surface.ts';
import { maskOptions, secureFieldMasks } from '../../src/observe.ts';
import { decodePng } from '../helpers/png.ts';
import { bounded, withMaskOwner, type MaskStep } from '../helpers/mask-capture-owner.ts';
import type { Socket } from 'node:net';

declare module 'vitest' {
  export interface ProvidedContext { maskCaptureEndpoint: string }
}

const FIELD = 'box-sizing:border-box;position:absolute;width:120px;height:30px;border:0;padding:0;background:red;color:red';
/** Six real secure fields span light DOM and each open/closed nesting pair. */
function fieldMarkup(): string {
  return `<style>body{margin:0}input{${FIELD}}</style>
<input id="light" type="PaSsWoRd" value="synthetic-only" style="left:10px;top:10px">
<input type="text" value="public control" style="left:10px;top:160px">
<div id="open" style="position:absolute;left:150px;top:10px"></div>
<div id="closed" style="position:absolute;left:10px;top:60px"></div>
<div id="open-closed" style="position:absolute;left:150px;top:60px"></div>
<div id="closed-open" style="position:absolute;left:10px;top:110px"></div>
<div id="open-open" style="position:absolute;left:150px;top:110px"></div>`;
}
/** Shared bootstrap for actual open and closed roots in each document. */
function fieldScript(): string {
  return `const input='<style>input{${FIELD};left:0;top:0}</style><input id="shadow" type="password" value="synthetic-only">';
for(const mode of ['open','closed'])document.getElementById(mode).attachShadow({mode}).innerHTML=input;
for(const modes of [['open','closed'],['closed','open'],['open','open']]){
 const outer=document.getElementById(modes.join('-')).attachShadow({mode:modes[0]});
 const nested=document.createElement('div');nested.id=modes.join('-')+'-nested';outer.append(nested);
 nested.attachShadow({mode:modes[1]}).innerHTML=input;
}
globalThis.maskFixtureReady=true;`;
}
/** The same synthetic fields for ordinary and rewritten documents. */
function fields(): string {
  return `${fieldMarkup()}<script>${fieldScript()}</script>`;
}
/** HTML closing tags must not terminate the parent's inline script literal. */
function scriptLiteral(value: string): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
/** Normal and source-shaped JavaScript document creation share the exact fields. */
function fixture(mode: string, peer: string): string {
  const child = `<!doctype html>${fields()}`;
  return `<!doctype html>${fields()}
<div style="position:absolute;left:300px;top:780px;width:40px;height:40px;background:#00ff00"></div>
<script>
const frame=document.createElement('iframe');
frame.style.cssText='position:absolute;left:10px;top:220px;width:300px;height:220px;border:0';
${mode === 'http' ? "frame.src='/child';document.body.append(frame);" : mode === 'bootstrap' ? `frame.src='javascript:false';document.body.append(frame);
const doc=frame.contentWindow.document;
doc.open()._l=function(){const script=this.createElement('script');script.defer=true;script.src=window.location.origin+'/bootstrap.js';this.body.appendChild(script)};
doc.write('<body onload="document._l();">');doc.close();` : `frame.src=${JSON.stringify(mode === 'void' ? 'javascript:void(0)' : 'javascript:false')};
frame.onload=()=>{frame.onload=null;const doc=frame.contentWindow.document;doc.open();doc.write(${scriptLiteral(child)});doc.close()};document.body.append(frame);`}
const cross=document.createElement('iframe');cross.src=${JSON.stringify(peer + '/child')};
cross.style.cssText='position:absolute;left:10px;top:450px;width:300px;height:220px;border:0';document.body.append(cross);
</script>`;
}
/** Full opaque proof regions, not a few sample pixels. */
function verifyPixels(bytes: Uint8Array): void {
  const image = decodePng(bytes);
  expect([image.width, image.height]).toEqual([390, 844]);
  for (const [left, top] of [[0, 0], [10, 220], [10, 450]] as const) {
    for (const [x, y] of [[10, 10], [150, 10], [10, 60], [150, 60], [10, 110], [150, 110]] as const) {
      for (let row = top + y + 2; row < top + y + 28; row++) {
        for (let column = left + x + 2; column < left + x + 118; column++) {
          expect(image.pixelAt(column, row)).toEqual([0, 0, 0, 255]);
        }
      }
    }
    for (let row = top + 162; row < top + 188; row++) {
      for (let column = left + 12; column < left + 128; column++) expect(image.pixelAt(column, row)).toEqual([255, 0, 0, 255]);
    }
  }
  for (let y = 782; y < 818; y++) for (let x = 302; x < 338; x++) expect(image.pixelAt(x, y)).toEqual([0, 255, 0, 255]);
}
/** Count the reader's secure set independently of the mask selector's count. */
function secureCount(node: SemanticNode): number {
  return (node.states?.secure ? 1 : 0) + (node.children ?? []).reduce((sum, child) => sum + secureCount(child), 0);
}

// The owned browser/process-group cleanup is qualified on macOS and Linux.
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux').each(['chromium', 'firefox', 'webkit'] as const)('JavaScript-frame masked capture: %s', (browser) => {
  /** Each case owns HTTP sockets and uses an independently bounded browser owner. */
  async function inFixture(mode: string, run: (surface: PlaywrightSurface, directory: string, step: MaskStep) => Promise<void>): Promise<void> {
    const servers: Server[] = [createServer(), createServer()];
    const sockets = new Set<Socket>();
    let origin = '';
    let peer = '';
    const closeHttp = async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => server.listening ? bounded(new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), 750) : Promise.resolve()));
    };
    await withMaskOwner(browser, inject('maskCaptureEndpoint') || undefined, closeHttp, async (surface, directory, step) => {
      for (const server of servers) {
        server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
        server.on('request', (request, response) => {
          const pathname = new URL(request.url!, 'http://127.0.0.1').pathname;
          if (pathname === '/bootstrap.js') {
            response.setHeader('Content-Type', 'application/javascript');
            response.end(`document.body.innerHTML=${scriptLiteral(fieldMarkup())};${fieldScript()}globalThis.maskBootstrapReady=true;`);
            return;
          }
          response.setHeader('Content-Type', 'text/html');
          response.end(pathname === '/child' ? `<!doctype html>${fields()}` : fixture(pathname.slice(1), peer));
        });
        await step(() => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }));
      }
      origin = `http://127.0.0.1:${(servers[0]!.address() as AddressInfo).port}`;
      peer = `http://127.0.0.1:${(servers[1]!.address() as AddressInfo).port}`;
      let externalAttempts = 0;
      await step(() => surface.requireContext().route('**/*', (route) => {
        if ([origin, peer].includes(new URL(route.request().url()).origin)) return route.continue();
        externalAttempts++;
        return route.abort();
      }));
      await step((operation) => surface.open(`${origin}/${mode}`, operation));
      const page = surface.requirePage();
      await step(() => page.waitForFunction(() => document.querySelectorAll('iframe').length === 2, undefined, { timeout: 5_000 }));
      await step(() => Promise.all(page.frames().map((frame) => frame.waitForFunction(() => Reflect.get(globalThis, 'maskFixtureReady') === true, undefined, { timeout: 5_000 }))));
      if (mode === 'bootstrap') {
        await step(() => page.waitForFunction(() => {
          const child = document.getElementsByTagName('iframe')[0]?.contentWindow;
          return child !== null && child !== undefined && Reflect.get(child, 'maskBootstrapReady') === true;
        }, undefined, { timeout: 5_000 }));
      }
      await run(surface, directory, step);
      expect(externalAttempts).toBe(0);
    });
  }

  for (const mode of ['http', 'false', 'void', 'bootstrap']) {
    it(`keeps every light/open/closed mask and observation pixel in a ${mode} frame`, async () => {
      await inFixture(mode, async (engine, _directory, step) => {
        const page = engine.requirePage();
        const counts = await step(() => Promise.all(secureFieldMasks(page).map((mask) => mask.count())));
        expect(counts).toHaveLength(6);
        expect(counts).toEqual([3, 3, 3, 3, 3, 3]);
        const observed = await step((operation) => engine.observe(operation, { pixels: true }));
        expect(secureCount(observed.root)).toBe(18);
        expect(observed.maskedRegionCount).toBe(18);
        expect(observed.maskedRegionCount).toBeGreaterThanOrEqual(secureCount(observed.root));
        expect(observed.pixels).toBeDefined();
        verifyPixels(observed.pixels!.data);
      });
    });
    it(`masks every inset pixel in the artifact from a ${mode} frame`, async () => {
      await inFixture(mode, async (engine, directory, step) => {
        const file = await step((operation) => engine.screenshot('javascript-frame', operation));
        verifyPixels(readFileSync(path.join(directory, file)));
      });
    });
    it(`retains all masks in a direct technical capture of a ${mode} frame`, async () => {
      await inFixture(mode, async (engine, _directory, step) => {
        const page = engine.requirePage();
        verifyPixels(await step(() => page.screenshot({ type: 'png', scale: 'css', timeout: 5_000, ...maskOptions(secureFieldMasks(page)) })));
      });
    });
  }

  it('keeps the native fixed CSS predicate and light/open traversal order', async () => {
    await inFixture('http', async (engine, _directory, step) => {
      const page = engine.requirePage();
      for (const [index, frame] of page.frames().entries()) {
        const old = frame.locator('input[type="password" i]');
        const captured = secureFieldMasks(page)[index * 2]!;
        const ids = (elements: Element[]) => elements.map((element) => {
          const root = element.getRootNode();
          return `${element.id}:${root instanceof ShadowRoot ? root.host.id : 'document'}`;
        });
        expect(await step(() => captured.evaluateAll(ids))).toEqual(await step(() => old.evaluateAll(ids)));
      }
    });
  });

  it('refuses a document query getter at the captured entry without executing it', async () => {
    await inFixture('http', async (engine, _directory, step) => {
      const result = await step(() => engine.requirePage().evaluate(() => {
        const before = Object.getOwnPropertyDescriptor(Document.prototype, 'querySelectorAll')!;
        let getterCalls = 0;
        Object.defineProperty(Document.prototype, 'querySelectorAll', { configurable: true, get() { getterCalls++; return () => []; } });
        try {
          const record = Reflect.get(globalThis, Symbol.for('e2e.closedShadowRoots')) as { querySecureFields(root: Document): Element[] };
          try { record.querySecureFields(document); return { refused: false, getterCalls }; }
          catch (error) { return { refused: error instanceof Error && error.message === 'secure-field DOM integrity is unavailable for this document', getterCalls }; }
        } finally { Object.defineProperty(Document.prototype, 'querySelectorAll', before); }
      }));
      expect(result).toEqual({ refused: true, getterCalls: 0 });
    });
  });

  it('refuses DOM query/shadow drift without invoking replacement getters', async () => {
    await inFixture('http', async (engine, _directory, step) => {
      const page = engine.requirePage();
      for (const mutation of ['document', 'fragment', 'element', 'shadow-prototype', 'shadow-instance', 'shadow-subclass'] as const) {
        await step(() => page.evaluate((kind) => {
          const element = document.getElementById('open')!;
          const originalPrototype = Object.getPrototypeOf(element) as object;
          const subclass = Object.create(originalPrototype) as object;
          const target = kind === 'document' ? Document.prototype : kind === 'fragment' ? DocumentFragment.prototype : kind === 'element' ? document.body : kind === 'shadow-prototype' ? Element.prototype : kind === 'shadow-subclass' ? subclass : element;
          const key = kind.startsWith('shadow') ? 'shadowRoot' : 'querySelectorAll';
          const before = Object.getOwnPropertyDescriptor(target, key);
          (window as unknown as { maskRestore: () => void; maskGetterCalls: number }).maskGetterCalls = 0;
          (window as unknown as { maskRestore: () => void }).maskRestore = () => { Object.setPrototypeOf(element, originalPrototype); if (before) Object.defineProperty(target, key, before); else Reflect.deleteProperty(target, key); };
          // Playwright itself reads the document method before dispatch. Its
          // outer boundary is not this engine's getter-isolation guarantee.
          if (kind === 'document' || kind === 'element') Object.defineProperty(target, key, { configurable: true, value: () => { (window as unknown as { maskGetterCalls: number }).maskGetterCalls++; return []; } });
          else Object.defineProperty(target, key, { configurable: true, get() { (window as unknown as { maskGetterCalls: number }).maskGetterCalls++; return key === 'shadowRoot' ? null : () => []; } });
          if (kind === 'shadow-subclass') Object.setPrototypeOf(element, subclass);
        }, mutation));
        try {
          const masks = mutation === 'element'
            ? [page.locator('css=body >> e2e-secure=input[type="password" i]')]
            : secureFieldMasks(page).slice(0, 1);
          await expect(step(() => masks[0]!.count())).rejects.toThrow(/secure-field DOM integrity/);
          expect(await step(() => page.evaluate(() => (window as unknown as { maskGetterCalls: number }).maskGetterCalls))).toBe(0);
        } finally {
          await step(() => page.evaluate(() => (window as unknown as { maskRestore: () => void }).maskRestore()));
        }
      }
    });
  });
});
