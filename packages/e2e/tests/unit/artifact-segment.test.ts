/**
 * The name a result goes by on disk, its trace page's and its artifact
 * directory's: the test file's name, the title's first words, and the head of
 * the result id, always one safe path segment.
 */

import { describe, expect, it } from 'vitest';
import { resultSegment } from '../../src/run/artifacts.ts';

const SAFE_SEGMENT = /^[a-z0-9-]+$/;
const ID = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';

describe('resultSegment', () => {
  it('names a result by its file, the first words of its title, and the head of its id', () => {
    expect(resultSegment({ id: ID, file: 'tests/checkout.e2e.ts', titlePath: ['applies the coupon'] })).toBe('checkout-applies-the-coupon-1a2b3c4d5e6f7a8b');
    expect(resultSegment({ id: ID, file: 'apps/shop/tests/cart.spec.mts', titlePath: ['cart', 'keeps items'] })).toBe('cart-spec-cart-keeps-items-1a2b3c4d5e6f7a8b');
  });

  it('leaves out a first title word the file name already says', () => {
    expect(resultSegment({ id: ID, file: 'tests/todos.e2e.ts', titlePath: ['todos', 'adds todos with the button and the keyboard'] })).toBe(
      'todos-adds-todos-with-the-button-and-1a2b3c4d5e6f7a8b',
    );
    expect(resultSegment({ id: ID, file: 'explore', titlePath: ['Explore the app and find bugs'] })).toBe('explore-the-app-and-find-bugs-1a2b3c4d5e6f7a8b');
  });

  it('keeps two results with the same words apart by their ids', () => {
    const titlePath = ['checkout', 'applies the coupon'];
    const web = resultSegment({ id: 'aaaaaaaaaaaaaaaa1111', file: 'tests/checkout.e2e.ts', titlePath });
    const ios = resultSegment({ id: 'aaaaaaaabbbbbbbb1111', file: 'tests/checkout.e2e.ts', titlePath });
    expect(web).not.toBe(ios);
  });

  it('drops accents, falls back to the id alone, and cuts one long word, always a safe segment', () => {
    const segments = [
      resultSegment({ id: ID, file: 'tests/koszyk.e2e.ts', titlePath: ['Sprawdź koszyk: żółć, Łódź'] }),
      resultSegment({ id: ID, file: '購入.e2e.ts', titlePath: ['購入フローを確認する'] }),
      resultSegment({ id: ID, file: 'tests/x.e2e.ts', titlePath: [`${'y'.repeat(300)} and more`] }),
      resultSegment({ id: ID, file: '../../etc/passwd', titlePath: ['../../etc/passwd'] }),
    ];
    expect(segments[0]).toBe('koszyk-sprawdz-koszyk-zolc-lodz-1a2b3c4d5e6f7a8b');
    expect(segments[1]).toBe('1a2b3c4d5e6f7a8b');
    expect(segments[2]).toBe(`x-${'y'.repeat(32)}-1a2b3c4d5e6f7a8b`);
    expect(segments[3]).toBe('passwd-etc-passwd-1a2b3c4d5e6f7a8b');
    for (const segment of segments) expect(segment).toMatch(SAFE_SEGMENT);
  });
});
