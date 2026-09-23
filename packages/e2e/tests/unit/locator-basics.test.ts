/**
 * The set reads and matchers a Playwright user reaches for first: `all`,
 * `allTextContents`, `isHidden`, `isDisabled`, `isEnabled`, `isChecked`,
 * `toBeAttached`, and the list form of `toHaveText` and `toContainText`, each
 * with its zero-match and ambiguity behaviour.
 */

import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { createScreenFixture, SCREEN_FIXTURE_TIMEOUT_MS } from '../helpers/screen-fixture.ts';

function item(id: string, text: string, states?: NonNullable<SemanticNode['states']>): SemanticNode {
  return { ref: { id, revision: '' }, role: 'listitem', text, ...(states === undefined ? {} : { states }) };
}

const ITEMS: readonly SemanticNode[] = [
  item('a', '  Item \n Alpha '),
  item('b', 'Item Beta'),
  item('c', 'Item Gamma'),
];
const SHOWN = item('shown', 'Shown');
const HIDDEN = item('hidden', 'Hidden', { hidden: true });

describe('all and allTextContents', () => {
  it('hands back one nth locator per current match, in document order', async () => {
    const all = await createScreenFixture(ITEMS).getByRole('listitem').all();
    expect(all).toHaveLength(3);
    const texts = [];
    for (const locator of all) texts.push(await locator.textContent());
    expect(texts).toEqual(['Item Alpha', 'Item Beta', 'Item Gamma']);
  });

  it('reads the normalized text of every match without strictness', async () => {
    expect(await createScreenFixture(ITEMS).getByRole('listitem').allTextContents()).toEqual([
      'Item Alpha',
      'Item Beta',
      'Item Gamma',
    ]);
  });

  it('answers zero matches with empty lists instead of waiting', async () => {
    const screen = createScreenFixture([]);
    const started = Date.now();
    expect(await screen.getByRole('listitem').all()).toEqual([]);
    expect(await screen.getByRole('listitem').allTextContents()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(SCREEN_FIXTURE_TIMEOUT_MS);
  });

  it('reads a match without text as an empty string', async () => {
    const screen = createScreenFixture([{ ref: { id: 'bare', revision: '' }, role: 'listitem' }]);
    expect(await screen.getByRole('listitem').allTextContents()).toEqual(['']);
  });

  it('denies allTextContents when a match is a secure field, like textContent', async () => {
    const screen = createScreenFixture([SHOWN, item('pw', 'hunter2', { secure: true })]);
    await expect(screen.getByRole('listitem').allTextContents()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });
});

describe('isHidden and isDisabled', () => {
  it('isHidden is true for an absent node and a hidden one, false for a shown one', async () => {
    expect(await createScreenFixture([]).getByText('Gone').isHidden()).toBe(true);
    expect(await createScreenFixture([HIDDEN]).getByText('Hidden').isHidden()).toBe(true);
    expect(await createScreenFixture([SHOWN]).getByText('Shown').isHidden()).toBe(false);
  });

  it('isHidden fails on several matches, like isVisible', async () => {
    await expect(createScreenFixture(ITEMS).getByRole('listitem').isHidden()).rejects.toMatchObject({
      code: 'LOCATOR_AMBIGUOUS',
    });
  });

  it('isDisabled mirrors isEnabled, secure fields included', async () => {
    expect(await createScreenFixture([item('x', 'x', { disabled: true })]).getByRole('listitem').isDisabled()).toBe(true);
    expect(await createScreenFixture([SHOWN]).getByRole('listitem').isDisabled()).toBe(false);
    expect(
      await createScreenFixture([item('pw', '', { secure: true, disabled: true })]).getByRole('listitem').isDisabled(),
    ).toBe(true);
  });

  it('isDisabled fails on zero and several matches, like isEnabled', async () => {
    await expect(createScreenFixture([]).getByRole('listitem').isDisabled()).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
    });
    await expect(createScreenFixture(ITEMS).getByRole('listitem').isDisabled()).rejects.toMatchObject({
      code: 'LOCATOR_AMBIGUOUS',
    });
  });
});

describe('isChecked and isEnabled', () => {
  it('isChecked reads the checked state: true, false, and no state at all as false', async () => {
    expect(await createScreenFixture([item('on', 'On', { checked: true })]).getByRole('listitem').isChecked()).toBe(true);
    expect(await createScreenFixture([item('off', 'Off', { checked: false })]).getByRole('listitem').isChecked()).toBe(false);
    expect(await createScreenFixture([SHOWN]).getByRole('listitem').isChecked()).toBe(false);
  });

  it('isChecked reads a secure field, since a state is not a value', async () => {
    expect(
      await createScreenFixture([item('pw', '', { secure: true, checked: true })]).getByRole('listitem').isChecked(),
    ).toBe(true);
  });

  it('isEnabled is true with no states and with disabled: false, false once disabled', async () => {
    expect(await createScreenFixture([SHOWN]).getByRole('listitem').isEnabled()).toBe(true);
    expect(await createScreenFixture([item('x', 'x', { disabled: false })]).getByRole('listitem').isEnabled()).toBe(true);
    expect(await createScreenFixture([item('x', 'x', { disabled: true })]).getByRole('listitem').isEnabled()).toBe(false);
  });

  it('both fail at once on zero matches, where isVisible answers false, and on several, like isVisible', async () => {
    const none = createScreenFixture([]).getByRole('listitem');
    const several = createScreenFixture(ITEMS).getByRole('listitem');
    const started = Date.now();
    await expect(none.isChecked()).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    await expect(none.isEnabled()).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    await expect(several.isChecked()).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
    await expect(several.isEnabled()).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
    expect(await none.isVisible()).toBe(false);
    expect(Date.now() - started).toBeLessThan(SCREEN_FIXTURE_TIMEOUT_MS);
  });
});

describe('toBeAttached', () => {
  it('passes on a hidden node, where toBeVisible would not', async () => {
    const locator = createScreenFixture([HIDDEN]).getByText('Hidden');
    await expectFixture(locator).toBeAttached();
    await expectFixture(locator).toBeHidden();
  });

  it('fails on zero matches once the timeout passes', async () => {
    const locator = createScreenFixture([]).getByText('Gone');
    await expect(expectFixture(locator).toBeAttached()).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('observed: no node (match count 0)'),
    });
  });

  it('negated passes on zero matches and fails on a hidden node', async () => {
    await expectFixture(createScreenFixture([]).getByText('Gone')).not.toBeAttached();
    await expect(
      expectFixture(createScreenFixture([HIDDEN]).getByText('Hidden')).not.toBeAttached(),
    ).rejects.toMatchObject({ code: 'ASSERTION_FAILED' });
  });

  it('is LOCATOR_AMBIGUOUS on several matches, like every positive matcher', async () => {
    await expect(
      expectFixture(createScreenFixture(ITEMS).getByRole('listitem')).toBeAttached(),
    ).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
  });
});

describe('the list form of toHaveText and toContainText', () => {
  it('requires the match count and each entry at its position', async () => {
    const locator = createScreenFixture(ITEMS).getByRole('listitem');
    await expectFixture(locator).toHaveText(['Item Alpha', /Beta$/, 'Item  Gamma']);
    await expectFixture(locator).toContainText(['Alpha', 'Beta', /gamma/i]);
  });

  it('fails on a count mismatch and reports every text it saw', async () => {
    const locator = createScreenFixture(ITEMS).getByRole('listitem');
    await expect(expectFixture(locator).toHaveText(['Item Alpha', 'Item Beta'])).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('observed: text ["Item Alpha", "Item Beta", "Item Gamma"] (match count 3)'),
    });
  });

  it('fails when an entry is out of order or only contained', async () => {
    const locator = createScreenFixture(ITEMS).getByRole('listitem');
    await expect(
      expectFixture(locator).toHaveText(['Item Beta', 'Item Alpha', 'Item Gamma']),
    ).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('expected: text ["Item Beta", "Item Alpha", "Item Gamma"]'),
    });
    await expect(expectFixture(locator).toHaveText(['Alpha', 'Beta', 'Gamma'])).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
    });
  });

  it('negated passes when the list does not hold, on zero matches too', async () => {
    await expectFixture(createScreenFixture(ITEMS).getByRole('listitem')).not.toHaveText(['Item Alpha']);
    await expectFixture(createScreenFixture([]).getByRole('listitem')).not.toContainText(['Alpha']);
  });

  it('an empty list holds exactly when nothing matches', async () => {
    await expectFixture(createScreenFixture([]).getByRole('listitem')).toHaveText([]);
    await expect(
      expectFixture(createScreenFixture(ITEMS).getByRole('listitem')).toHaveText([]),
    ).rejects.toMatchObject({ code: 'ASSERTION_FAILED' });
  });

  it('keeps the single-value path strict on several matches', async () => {
    await expect(
      expectFixture(createScreenFixture(ITEMS).getByRole('listitem')).toHaveText('Item Alpha'),
    ).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
  });
});
