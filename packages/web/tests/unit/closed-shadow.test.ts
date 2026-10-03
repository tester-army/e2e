/**
 * The closed-root record and the selector engines built on it, run as page
 * code against a scripted document: the init script counts the closed roots
 * it records, and a document that attached none is never walked, since every
 * locator resolution goes through `e2e-roots=`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOSED_SHADOW_ROOTS_INIT_SCRIPT,
  CLOSED_SHADOW_ROOTS_KEY,
  CLOSED_SHADOW_SELECTOR_ENGINE,
  CLOSED_SHADOW_SELECTOR_ENGINES,
  SEARCH_ROOTS_SELECTOR_ENGINE,
} from '../../src/closed-shadow.ts';

const KEY = Symbol.for(CLOSED_SHADOW_ROOTS_KEY);

interface Record extends WeakMap<object, object> { count: number }

/** The engine factory of one registered name, materialized as the browser connection materializes it. */
function engine(name: string): { queryAll(root: object, selector: string): unknown[] } {
  const source = CLOSED_SHADOW_SELECTOR_ENGINES.find((candidate) => candidate.name === name)?.source;
  if (source === undefined) throw new Error(`no engine named ${name}`);
  return (new Function(`return (${source})();`) as () => { queryAll(root: object, selector: string): unknown[] })();
}

/** Publishes a record like the init script's, with the count given. */
function publish(count: number): Record {
  const roots = new WeakMap() as Record;
  Object.defineProperty(roots, 'count', { value: count, writable: true });
  Object.defineProperty(globalThis, KEY, { value: roots, configurable: true, writable: true });
  return roots;
}

/** A document or element root that reports every `querySelectorAll` call. */
function root(nodeType: 1 | 9, elements: object[] = []) {
  const querySelectorAll = vi.fn(() => elements);
  return { nodeType, shadowRoot: null, querySelectorAll };
}

/** Runs the init script against a page global of its own; the record it installs is not configurable. */
function installInitScript(): { global: object; Element: { prototype: { attachShadow(init: { mode: string }): object } } } {
  const attached: object[] = [];
  const Element = { prototype: { attachShadow(this: object, init: { mode: string }) {
    const created = { mode: init.mode };
    attached.push(created);
    return created;
  } } };
  const global = {};
  const install = new Function('globalThis', 'Element', CLOSED_SHADOW_ROOTS_INIT_SCRIPT) as (global: object, element: object) => void;
  install(global, Element);
  return { global, Element };
}

describe('closed shadow root record', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, KEY);
  });

  it('counts the closed roots the wrapped attachShadow records and leaves open ones out', () => {
    const { global, Element } = installInitScript();
    const record = Reflect.get(global, KEY) as Record;
    expect(record).toBeInstanceOf(WeakMap);
    expect(record.count).toBe(0);
    const { attachShadow } = Element.prototype;
    const openHost = {};
    const closedHost = {};
    const open = attachShadow.call(openHost, { mode: 'open' });
    expect(open).toEqual({ mode: 'open' });
    expect(record.count).toBe(0);
    expect(record.get(openHost)).toBeUndefined();
    const closed = attachShadow.call(closedHost, { mode: 'closed' });
    expect(record.count).toBe(1);
    expect(record.get(closedHost)).toBe(closed);
    // Installed once per document: a second run leaves the record and the wrapper alone.
    const again = new Function('globalThis', 'Element', CLOSED_SHADOW_ROOTS_INIT_SCRIPT) as (global: object, element: object) => void;
    again(global, Element);
    expect(Reflect.get(global, KEY)).toBe(record);
    expect(Element.prototype.attachShadow).toBe(attachShadow);
  });

  it('answers a semantic query with the root alone, without walking, while no closed root was attached', () => {
    const record = publish(0);
    const search = engine(SEARCH_ROOTS_SELECTOR_ENGINE);
    const document = root(9);
    expect(search.queryAll(document, '')).toEqual([document]);
    expect(document.querySelectorAll).not.toHaveBeenCalled();
    // The count is read at query time, so a root attached later is searched.
    const host = root(1);
    const closed = root(9);
    record.set(host, closed);
    record.count = 1;
    const walked = root(9, [host]);
    expect(search.queryAll(walked, '')).toEqual([walked, closed]);
    expect(walked.querySelectorAll).toHaveBeenCalledWith('*');
  });

  it('lets the mask engine find nothing without walking while no closed root was attached, and refuses an untracked document', () => {
    publish(0);
    const masks = engine(CLOSED_SHADOW_SELECTOR_ENGINE);
    const document = root(9);
    expect(masks.queryAll(document, 'input[type="password" i]')).toEqual([]);
    expect(document.querySelectorAll).not.toHaveBeenCalled();
    Reflect.deleteProperty(globalThis, KEY);
    const untracked = engine(CLOSED_SHADOW_SELECTOR_ENGINE);
    expect(() => untracked.queryAll(document, 'input')).toThrow(/tracking is unavailable/);
    expect(engine(SEARCH_ROOTS_SELECTOR_ENGINE).queryAll(document, '')).toEqual([document]);
  });
});
