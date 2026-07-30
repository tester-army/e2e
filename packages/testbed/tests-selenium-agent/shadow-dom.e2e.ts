import { test, expect } from 'e2e';

/**
 * The `<fancy-tabs>` component. Its tab buttons and panels are slotted light
 * DOM, so the observation walk sees them; the tab strip and panel container
 * live in the shadow root, and the walk iterates `el.children` without ever
 * entering a `shadowRoot`, so those are invisible to the agent even though a
 * CSS selector pierces straight through.
 *
 * The tabs also get their roles from script at connect time, so this is a check
 * that the observation reflects the live accessibility state rather than markup.
 */
test.describe('shadow dom', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/other/shadow_dom');
  });

  test('selects a slotted tab and judges the swap', async ({ agent, screen }) => {
    await agent.tap('the Tab 2 button');

    await expect(screen.getByRole('tab', { name: 'Tab 2' })).toBeSelected();
    await expect(screen.getByText('Content Panel 2')).toBeVisible();
    await agent.assert('the second content panel is the one being shown');
  });

  test('judges the selection state of a scripted role', async ({ agent, screen }) => {
    await agent.tap('the Tab 3 button');

    await expect(screen.getByText('Content Panel 3')).toBeVisible();
    // `role="tab"` and `aria-selected` are assigned by the component at connect
    // time, so a judgment that lands here proves the observation reads live
    // accessibility state, not markup.
    await agent.assert('the third tab is selected and its panel is visible');
  });
});
