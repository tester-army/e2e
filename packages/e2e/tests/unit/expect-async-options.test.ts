import { describe, expect as vexpect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { expect as expectFixture } from '../../src/expect/index.ts';
import type { AsyncExpectation } from '../../src/types.ts';
import { createScreenFixture } from '../helpers/screen-fixture.ts';

const checked: SemanticNode = {
  ref: { id: 'node-1', revision: '' },
  role: 'checkbox',
  name: 'Agree',
  testId: 'agree',
  states: { checked: true },
};
const unchecked: SemanticNode = { ref: { id: 'node-2', revision: '' }, role: 'checkbox', testId: 'terms' };
const disabled: SemanticNode = {
  ref: { id: 'node-3', revision: '' },
  role: 'button',
  testId: 'locked',
  states: { disabled: true },
};
const hidden: SemanticNode = {
  ref: { id: 'node-4', revision: '' },
  role: 'generic',
  testId: 'tucked',
  states: { hidden: true },
};
const banner: SemanticNode = {
  ref: { id: 'node-5', revision: '' },
  role: 'alert',
  name: 'Save Error',
  testId: 'banner',
  text: 'Save Error',
  attributes: { 'data-kind': 'Error' },
};

const screen = createScreenFixture([checked, unchecked, disabled, hidden, banner]);
const at = (testId: string): AsyncExpectation => expectFixture(screen.getByTestId(testId));
const soon = { timeout: 100 };

/** Options typed as the caller's own object, the way a JavaScript test or a computed bag reaches the matcher. */
const computed = (options: Record<string, unknown>): { timeout?: number } => ({ ...options });

const failsAssertion = { code: 'ASSERTION_FAILED' };
const invalidArgument = { code: 'INVALID_ARGUMENT' };

describe('Playwright state flags on locator matchers', () => {
  it('toBeChecked({ checked: false }) waits for an unchecked node', async () => {
    await at('terms').toBeChecked({ checked: false });
    await at('agree').toBeChecked({ checked: true });
    await at('agree').not.toBeChecked({ checked: false, ...soon });
    await vexpect(at('agree').toBeChecked({ checked: false, ...soon })).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('expected: unchecked'),
    });
    await vexpect(at('terms').not.toBeChecked({ checked: false, ...soon })).rejects.toMatchObject(failsAssertion);
  });

  it('toBeEnabled({ enabled: false }) waits for a disabled node', async () => {
    await at('locked').toBeEnabled({ enabled: false });
    await at('banner').toBeEnabled({ enabled: true });
    await vexpect(at('banner').toBeEnabled({ enabled: false, ...soon })).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('expected: disabled'),
    });
  });

  it('toBeVisible({ visible: false }) waits for a hidden or absent node', async () => {
    await at('tucked').toBeVisible({ visible: false });
    await at('nowhere').toBeVisible({ visible: false });
    await at('banner').toBeVisible({ visible: true });
    await vexpect(at('banner').toBeVisible({ visible: false, ...soon })).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('expected: hidden or absent'),
    });
    await vexpect(at('tucked').not.toBeVisible({ visible: false, ...soon })).rejects.toMatchObject(failsAssertion);
  });

  it('toBeAttached({ attached: false }) waits for no match', async () => {
    await at('nowhere').toBeAttached({ attached: false });
    await at('tucked').toBeAttached({ attached: true });
    await vexpect(at('tucked').toBeAttached({ attached: false, ...soon })).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('expected: detached'),
    });
  });

  it('reads a computed option bag the same way', async () => {
    await vexpect(at('agree').toBeChecked(computed({ checked: false, ...soon }))).rejects.toMatchObject(failsAssertion);
    await vexpect(at('banner').toBeVisible(computed({ visible: false, ...soon }))).rejects.toMatchObject(failsAssertion);
    await vexpect(at('banner').toBeEnabled(computed({ enabled: false, ...soon }))).rejects.toMatchObject(failsAssertion);
    await vexpect(at('tucked').toBeAttached(computed({ attached: false, ...soon }))).rejects.toMatchObject(failsAssertion);
  });

  it('refuses a flag that is not a boolean', async () => {
    vexpect(() => at('agree').toBeChecked(computed({ checked: 'false' }))).toThrow(
      vexpect.objectContaining({ ...invalidArgument, message: vexpect.stringContaining('checked must be a boolean') }),
    );
    vexpect(() => at('banner').toBeVisible(computed({ visible: 0 }))).toThrow(vexpect.objectContaining(invalidArgument));
  });
});

describe('ignoreCase on text matchers', () => {
  it('matches a string regardless of case', async () => {
    await at('banner').toHaveText('save error', { ignoreCase: true });
    await at('banner').toContainText('ERROR', { ignoreCase: true });
    await at('banner').toHaveAccessibleName('SAVE ERROR', { ignoreCase: true });
    await at('banner').toHaveAttribute('data-kind', 'error', { ignoreCase: true });
    await at('banner').not.toContainText('error', { ignoreCase: false, ...soon });
  });

  it('fails a negated match that differs only in case', async () => {
    await vexpect(at('banner').not.toContainText('error', { ignoreCase: true, ...soon })).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('expected: not text containing "error" (ignoring case)'),
    });
    await vexpect(at('banner').not.toHaveText('SAVE ERROR', computed({ ignoreCase: true, ...soon }))).rejects.toMatchObject(
      failsAssertion,
    );
    await vexpect(at('banner').not.toHaveAttribute('data-kind', 'ERROR', { ignoreCase: true, ...soon })).rejects.toMatchObject(
      failsAssertion,
    );
  });

  it('keeps case-sensitive matching as the default', async () => {
    await at('banner').not.toContainText('error', soon);
    await vexpect(at('banner').toContainText('error', soon)).rejects.toMatchObject(failsAssertion);
  });

  it('adds or strips the i flag of a RegExp', async () => {
    await at('banner').toHaveText(/^save error$/, { ignoreCase: true });
    await at('banner').not.toHaveText(/^save error$/i, { ignoreCase: false, ...soon });
    await at('banner').toHaveText(/^save error$/i);
  });

  it('applies to every entry of a list', async () => {
    await at('banner').toContainText(['error'], { ignoreCase: true });
    await vexpect(at('banner').not.toHaveText(['save error'], { ignoreCase: true, ...soon })).rejects.toMatchObject(
      failsAssertion,
    );
  });
});

describe('options a matcher does not take', () => {
  it.each<[string, () => Promise<void>]>([
    ['toBeChecked indeterminate', () => at('agree').toBeChecked(computed({ indeterminate: true }))],
    ['toBeChecked on a negation', () => at('agree').not.toBeChecked(computed({ indeterminate: true }))],
    ['toBeDisabled enabled', () => at('locked').toBeDisabled(computed({ enabled: false }))],
    ['toBeHidden visible', () => at('tucked').toBeHidden(computed({ visible: true }))],
    ['toBeFocused focused', () => at('agree').toBeFocused(computed({ focused: false }))],
    ['toHaveValue ignoreCase', () => at('agree').toHaveValue('x', computed({ ignoreCase: true }))],
    ['toHaveText useInnerText', () => at('banner').toHaveText('Save Error', computed({ useInnerText: true }))],
    ['toHaveCount ignoreCase', () => at('banner').toHaveCount(1, computed({ ignoreCase: true }))],
    ['toHaveAttribute presence ignoreCase', () => at('banner').toHaveAttribute('data-kind', computed({ ignoreCase: true }))],
    [
      'toHaveAttribute presence ignoreCase after an undefined value',
      () => at('banner').toHaveAttribute('data-kind', undefined as never, computed({ ignoreCase: true })),
    ],
    ['toHaveAttribute null value', () => at('banner').toHaveAttribute('data-kind', null as never)],
    ['toHaveAttribute null options', () => at('banner').toHaveAttribute('data-kind', 'error', null as never)],
  ])('%s is INVALID_ARGUMENT before the first read', (_label, call) => {
    vexpect(call).toThrow(vexpect.objectContaining(invalidArgument));
  });

  it('names the key it refused and the ones the matcher takes', () => {
    vexpect(() => at('agree').not.toBeChecked(computed({ indeterminate: true }))).toThrow(
      'expect.not.toBeChecked options has no key "indeterminate"; it takes checked, timeout',
    );
  });

  it('refuses an option bag that is not a plain object', () => {
    vexpect(() => at('agree').toBeChecked([] as never)).toThrow(vexpect.objectContaining(invalidArgument));
  });
});
