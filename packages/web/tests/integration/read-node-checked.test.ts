/**
 * The real reader takes a native control's checked and selected state from
 * the control, and aria-* only where there is none, and reads a checkbox's or
 * radio's value apart from its checked state.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression, SemanticNode } from 'e2e/engine';
import { byRole, byTestId, startWebSession, type WebSession } from '../helpers/web-session.ts';

let page: WebSession;

beforeAll(async () => {
  page = await startWebSession();
});

afterAll(async () => {
  await page.close();
});

/** One observation of the page, keyed by test id. */
async function captureByTestId(): Promise<Map<string | undefined, SemanticNode>> {
  return new Map((await page.nodes()).map((node) => [node.testId, node]));
}

/** The names of the nodes a locate finds. */
async function namesOf(expression: LocatorExpression): Promise<(string | undefined)[]> {
  return (await page.locate(expression)).map((node) => node.name);
}

describe('checked and selected', () => {
  it('lists closed-select choices but excludes explicitly hidden options and optgroups', async () => {
    await page.setContent(`
      <select aria-label="Plan">
        <option data-testid="visible" selected value="internal-token">Visible</option>
        <option data-testid="disabled" disabled>Disabled</option>
        <option data-testid="hidden" hidden>Hidden</option>
        <option data-testid="display" style="display:none">No display</option>
        <option data-testid="visibility" style="visibility:hidden">No visibility</option>
        <option data-testid="aria" aria-hidden="true">No aria</option>
        <optgroup hidden label="Hidden group"><option data-testid="group">Hidden group choice</option></optgroup>
        <optgroup style="visibility:hidden" label="Restored group"><option data-testid="restored" style="visibility:visible">Restored</option></optgroup>
      </select>
    `);
    const nodes = await captureByTestId();
    expect(nodes.get('visible')).toMatchObject({ name: 'Visible', states: { selected: true } });
    expect(nodes.get('visible')?.value).toBeUndefined();
    expect(nodes.get('visible')?.states?.hidden).toBeUndefined();
    expect(nodes.get('disabled')).toMatchObject({ name: 'Disabled', states: { disabled: true } });
    expect(nodes.has('restored')).toBe(true);
    expect(nodes.has('visibility')).toBe(true);
    for (const id of ['hidden', 'display', 'aria', 'group']) expect(nodes.has(id)).toBe(false);
    expect((await page.locate(byRole('option'))).map((node) => node.testId)).toEqual(['visible', 'disabled', 'visibility', 'restored']);
  });

  it('applies the option limit to offered choices after hidden options are excluded', async () => {
    await page.setContent(`<select aria-label="Many choices">${'<option hidden>Excluded</option>'.repeat(60)}${Array.from({ length: 61 }, (_, index) => `<option data-testid="choice-${index}">Choice ${index}</option>`).join('')}</select>`);
    const nodes = await captureByTestId();
    expect(nodes.get('choice-0')?.name).toBe('Choice 0');
    expect(nodes.get('choice-59')?.name).toBe('Choice 59');
    expect(nodes.has('choice-60')).toBe(false);
    expect([...nodes.values()].filter((node) => node.role === 'option')).toHaveLength(60);
    expect(await page.locate(byRole('option'))).toHaveLength(61);
  });

  it('reads selected boolean values without case sensitivity while native option state wins', async () => {
    await page.setContent(`
      <div role="tablist">
        <button role="tab" aria-selected="TRUE" data-testid="upper">All</button>
        <button role="tab" aria-selected="TrUe" data-testid="mixed">Recent</button>
        <button role="tab" aria-selected="FALSE" data-testid="off">Archived</button>
      </div>
      <select aria-label="Plan" size="3">
        <option data-testid="native-on" selected aria-selected="FALSE">Team</option>
        <option data-testid="native-off" aria-selected="TRUE">Solo</option>
      </select>
      <div role="button" data-testid="embedded">Pick <div role="listbox"><div role="option" aria-selected="true">Chosen</div><div role="option" aria-selected="false">Other</div></div></div>
    `);
    const nodes = await captureByTestId();
    expect(nodes.get('upper')?.states?.selected).toBe(true);
    expect(nodes.get('mixed')?.states?.selected).toBe(true);
    expect(nodes.get('off')?.states?.selected).toBe(false);
    expect(nodes.get('native-on')?.states?.selected).toBe(true);
    expect(nodes.get('native-off')?.states?.selected).toBe(false);
    expect(nodes.get('embedded')?.name).toBe('Pick Chosen');
    expect(await page.locate(byRole('button', 'Pick Chosen'))).toHaveLength(1);
  });

  // Missing in BiDi: a role query's `selected` state compares aria-selected case-sensitively.
  it.skip('matches a role query on selected state without case sensitivity', async () => {
    await page.setContent(`
      <div role="tablist">
        <button role="tab" aria-selected="TRUE">All</button>
        <button role="tab" aria-selected="TrUe">Recent</button>
        <button role="tab" aria-selected="FALSE">Archived</button>
      </div>
    `);
    const selectedTabs: LocatorExpression = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'tab', exact: true }, states: { selected: true } } };
    expect(await namesOf(selectedTabs)).toEqual(['All', 'Recent']);
  });

  it('excludes uppercase hidden subtrees from observations and names but reads hidden references whole', async () => {
    await page.setContent(`
      <div aria-hidden="TRUE"><button data-testid="hidden" aria-hidden="false">Hidden action</button></div>
      <button data-testid="save">Save<span aria-hidden="TrUe"> decoration</span></button>
      <button data-testid="shown" aria-hidden="FALSE">Shown</button>
      <button data-testid="referenced" aria-labelledby="reference">Fallback</button>
      <div aria-hidden="TRUE"><span id="reference">Label <i style="display:none">whole</i></span></div>
    `);
    const nodes = await captureByTestId();
    expect(nodes.has('hidden')).toBe(false);
    expect(nodes.get('save')?.name).toBe('Save');
    expect(nodes.get('shown')?.name).toBe('Shown');
    expect(nodes.get('referenced')?.name).toBe('Label whole');
    expect(await page.locate(byRole('button', 'Save'))).toHaveLength(1);
    expect(await page.locate(byRole('button', 'Hidden action'))).toHaveLength(0);
    expect(await page.locate(byRole('button', 'Label whole'))).toHaveLength(1);
  });

  it('reads a native checkbox, radio, and option from the control even when a stale aria attribute disagrees', async () => {
    await page.setContent(`
      <input type="checkbox" data-testid="stale-off" aria-checked="false" checked aria-label="Stale off">
      <input type="checkbox" data-testid="stale-on" aria-checked="true" aria-label="Stale on">
      <input type="radio" name="r" data-testid="radio-stale-off" aria-checked="false" checked aria-label="Radio stale off">
      <input type="radio" name="r2" data-testid="radio-stale-on" aria-checked="true" aria-label="Radio stale on">
      <input type="checkbox" data-testid="plain-on" checked aria-label="Plain on">
      <input type="checkbox" data-testid="plain-off" aria-label="Plain off">
      <div role="checkbox" aria-checked="true" data-testid="aria-on" tabindex="0">Aria on</div>
      <div role="switch" aria-checked="false" data-testid="aria-off" tabindex="0">Aria off</div>
      <select data-testid="select" aria-label="Plan" size="3">
        <option data-testid="option-stale-off" aria-selected="false" selected>Team</option>
        <option data-testid="option-stale-on" aria-selected="true">Solo</option>
      </select>
      <div role="tablist"><button role="tab" aria-selected="true" data-testid="tab">All</button></div>
    `);
    const nodes = await captureByTestId();
    const checked = (testId: string) => nodes.get(testId)?.states?.checked;
    const selected = (testId: string) => nodes.get(testId)?.states?.selected;

    expect(checked('stale-off')).toBe(true);
    expect(checked('stale-on')).toBe(false);
    expect(checked('radio-stale-off')).toBe(true);
    expect(checked('radio-stale-on')).toBe(false);
    expect(checked('plain-on')).toBe(true);
    expect(checked('plain-off')).toBe(false);
    expect(checked('aria-on')).toBe(true);
    expect(checked('aria-off')).toBe(false);
    expect(selected('option-stale-off')).toBe(true);
    expect(selected('option-stale-on')).toBe(false);
    expect(selected('tab')).toBe(true);

    for (const testId of ['stale-off', 'stale-on', 'radio-stale-off', 'radio-stale-on', 'plain-on', 'plain-off', 'aria-on', 'aria-off']) {
      expect((await page.locate(byTestId(testId)))[0]?.states?.checked, testId).toBe(checked(testId));
    }
  });
});

describe('a checkable control\'s value', () => {
  it('reads the value attribute, `on` by default, whatever the checked state, as the control\'s own value reads', async () => {
    await page.setContent(`
      <input type="checkbox" data-testid="default-on" checked aria-label="Default on">
      <input type="checkbox" data-testid="default-off" aria-label="Default off">
      <input type="checkbox" data-testid="custom" value="yes" aria-label="Custom">
      <input type="radio" name="plan" data-testid="radio" value="monthly" aria-label="Monthly">
      <input type="radio" name="plan" data-testid="radio-default" aria-label="Default radio">
    `);
    const testIds = ['default-on', 'default-off', 'custom', 'radio', 'radio-default'];
    const values = await Promise.all(testIds.map(async (id) => (await page.readNode(`[data-testid="${id}"]`)).value));
    expect(values).toEqual(['on', 'on', 'yes', 'monthly', 'on']);
    const inputValues = await page.browser.evaluate(
      (ids: string[]) => ids.map((id) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!.value),
      testIds,
    );
    expect(inputValues).toEqual(values);
    // The tree drops the token, as it drops an option's value; the checked state says what matters.
    const nodes = await captureByTestId();
    expect(testIds.map((testId) => nodes.get(testId)?.value)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
