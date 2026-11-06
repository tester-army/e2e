/** The closed-root record, run as page code against a scripted page global: the init script counts the closed roots it records. */

import { afterEach, describe, expect, it } from 'vitest';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT, CLOSED_SHADOW_ROOTS_KEY } from '../../src/in-page/closed-shadow.ts';

const KEY = Symbol.for(CLOSED_SHADOW_ROOTS_KEY);

interface Record extends WeakMap<object, object> { count: number }

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
});
