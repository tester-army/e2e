/**
 * A capture nobody will act on (the trace's screen) reads the same tree as an
 * observation but no element handle per node: only iframe boundary elements
 * are fetched, to reach their frames.
 */

import { chromium, type Browser, type ElementHandle, type JSHandle, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OperationContext } from 'e2e/engine';
import { captureDocument, type DocumentHost } from '../../src/observation.ts';
import { captureObservation } from '../../src/observation-capture.ts';
import { RefRegistry } from '../../src/refs.ts';

let browser: Browser;

beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

const INNER = '<button>Inner</button><iframe title="deep" srcdoc="&lt;p&gt;Deep&lt;/p&gt;"></iframe>';
const DOCUMENT = `<h1>Host</h1><button>One</button><input aria-label="Name">
  <iframe title="inner" srcdoc="${INNER.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe><a href="/x">Link</a>`;

/** Wraps a host so the property reads made on its captured handles are counted. */
function counting(page: Page) {
  const reads = { all: 0, indexed: [] as string[] };
  const track = (handle: JSHandle): JSHandle => new Proxy(handle, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== 'function') return value;
      if (key === 'getProperties') return () => { reads.all += 1; return target.getProperties(); };
      if (key === 'getProperty') {
        return async (name: string) => {
          if (/^\d+$/.test(name)) reads.indexed.push(name);
          const property = await target.getProperty(name);
          return name === 'elements' ? track(property) : property;
        };
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
  const host: DocumentHost = { evaluateHandle: async (...args: Parameters<Page['evaluateHandle']>) => track(await page.evaluateHandle(...args)) } as DocumentHost;
  return { host, reads };
}

const capture = { framePath: [] as string[], budget: 100, signal: new AbortController().signal };

describe('trace-only capture', () => {
  it('reads the normal tree without a handle per node, fetching only iframe elements', async () => {
    const page = await browser.newPage();
    const published = new Map<string, ElementHandle<Element>>();
    try {
      await page.setContent(DOCUMENT);
      await page.frameLocator('iframe[title=inner]').frameLocator('iframe[title=deep]').getByText('Deep').waitFor();
      /** Each document gets its own id range, in the same order on every capture. */
      const base = () => {
        let ranges = 0;
        return { testIdAttribute: 'data-testid', site: undefined, reserveIds: () => 1 + 1_000 * ranges++ };
      };
      const normal = counting(page);
      const full = await captureDocument({ ...base(), commit: (id, element) => { published.set(id, element); } }, normal.host, { ...capture, deadline: Date.now() + 10_000 });
      const trace = counting(page);
      const light = await captureDocument(base(), trace.host, { ...capture, deadline: Date.now() + 10_000 });

      expect(JSON.stringify(light.tree)).toBe(JSON.stringify(full.tree));
      expect(light.nodeCount).toBe(full.nodeCount);
      expect(light.truncated).toBe(full.truncated);
      expect(JSON.stringify(light.tree)).toContain('Deep');
      expect(published.size).toBe(full.nodeCount);
      expect(normal.reads.all).toBeGreaterThan(0);
      expect(trace.reads.all).toBe(0);
      expect(trace.reads.indexed.length).toBeGreaterThan(0);
      expect(trace.reads.indexed.length).toBeLessThan(full.nodeCount);
    } finally {
      await Promise.all([...published.values()].map((element) => element.dispose()));
      await page.close();
    }
  });

  it('stages no refs and reads the same snapshot as an observation of the page', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(DOCUMENT);
      const refs = new RefRegistry();
      const operation: OperationContext = { signal: new AbortController().signal, timeoutMs: 10_000, runId: 'trace', attemptId: 'attempt', origin: 'test' };
      const settings = { testIdAttribute: 'data-testid', site: undefined };
      const trace = await captureObservation(page, refs, settings, operation, undefined, false);
      const real = await captureObservation(page, refs, settings, operation, undefined);
      try {
        expect(trace.generation.size).toBe(0);
        expect(real.generation.size).toBeGreaterThan(0);
        expect(JSON.stringify(trace.snapshot.root)).toBe(JSON.stringify(real.snapshot.root));
        expect(trace.snapshot.location).toBe(real.snapshot.location);
        expect(trace.snapshot.viewport).toEqual(real.snapshot.viewport);
      } finally {
        RefRegistry.dispose(real.generation);
      }
    } finally {
      await page.close();
    }
  });
});
