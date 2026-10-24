import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, querySuffix, searchProducts } from '../catalog.mjs';

test('fresh links parse and canonically encode Unicode and literal plus', () => {
  assert.equal(parseQuery('?q=%C2%A0Cafe%CC%81%20%2B%20Mug%20&q=ignored'), 'Café + Mug');
  assert.equal(querySuffix(' Café + Mug '), '?q=Caf%C3%A9%20%2B%20Mug');
  assert.throws(() => parseQuery('?q=%C3%28'), /Invalid search link/);
});
test('empty queries select the catalog and mug search has stable identities', () => {
  assert.equal(searchProducts('').length, 7);
  assert.deepEqual(searchProducts('mug').map(product => product.id), ['cafe-mug', 'titanium-mug']);
  assert.deepEqual(searchProducts('CAFÉ').map(product => product.id), ['cafe-mug']);
  assert.equal(querySuffix(''), '');
});
test('equal names remain distinct and sort by stable ID', () => {
  assert.deepEqual(searchProducts('same', [{ id: 'b', name: 'Same' }, { id: 'a', name: 'Same' }]).map(product => product.id), ['a', 'b']);
});
