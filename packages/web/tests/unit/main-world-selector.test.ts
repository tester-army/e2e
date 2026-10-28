/** The main-world mask engine admits only the shared secure predicate and init-time native query. */
import { afterEach, expect, it, vi } from 'vitest';
import { CLOSED_SHADOW_ROOTS_KEY } from '../../src/closed-shadow.ts';
import { MAIN_WORLD_SELECTOR_ENGINE_SOURCE } from '../../src/main-world-selector.ts';
import { SECURE_FIELD_SELECTOR } from '../../src/read-node.ts';

const key = Symbol.for(CLOSED_SHADOW_ROOTS_KEY);

/** Materialize the same engine factory Playwright registers. */
function engine(): { queryAll(root: object, body: string): unknown[] } {
  return new Function(`return (${MAIN_WORLD_SELECTOR_ENGINE_SOURCE})();`)() as { queryAll(root: object, body: string): unknown[] };
}

afterEach(() => { Reflect.deleteProperty(globalThis, key); });

it('refuses a missing or earlier closed-root record before querying', () => {
  expect(() => engine().queryAll({}, SECURE_FIELD_SELECTOR)).toThrow(/secure-field DOM integrity/);
  Object.defineProperty(globalThis, key, { value: new WeakMap(), configurable: true });
  expect(() => engine().queryAll({}, SECURE_FIELD_SELECTOR)).toThrow(/secure-field DOM integrity/);
});

it('returns exactly the captured query result and refuses any other predicate', () => {
  const root = {};
  const fields = [{}, {}];
  const querySecureFields = vi.fn(() => fields);
  const record = new WeakMap();
  Object.defineProperties(record, { maskDOMVersion: { value: 1 }, querySecureFields: { value: querySecureFields } });
  Object.defineProperty(globalThis, key, { value: record, configurable: true });
  const selector = engine();
  for (const body of ['', 'input', `${SECURE_FIELD_SELECTOR},textarea`, 'input[type=password]']) {
    expect(() => selector.queryAll(root, body)).toThrow(/only accepts the native secure predicate/);
  }
  expect(querySecureFields).not.toHaveBeenCalled();
  expect(selector.queryAll(root, SECURE_FIELD_SELECTOR)).toBe(fields);
  expect(querySecureFields).toHaveBeenCalledExactlyOnceWith(root);
});

it('propagates integrity failure instead of returning an empty mask', () => {
  const record = new WeakMap();
  Object.defineProperties(record, {
    maskDOMVersion: { value: 1 },
    querySecureFields: { value: () => { throw new Error('secure-field DOM integrity is unavailable for this document'); } },
  });
  Object.defineProperty(globalThis, key, { value: record, configurable: true });
  expect(() => engine().queryAll({}, SECURE_FIELD_SELECTOR)).toThrow(/secure-field DOM integrity/);
});
