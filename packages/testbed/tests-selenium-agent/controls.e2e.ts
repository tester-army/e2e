import { test, expect } from 'e2e';
import { z } from 'zod';

/**
 * The agent against /demo_page, where most controls have no accessible name at
 * all — the labels are sibling table cells. A deterministic test has to fall
 * back to ids here (see tests-selenium/demo-page.e2e.ts); the agent should be
 * able to use the visual/structural association a person uses instead, which is
 * the single clearest thing the agent tier buys.
 */
test.describe('demo page', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/demo_page');
  });

  test('types into a field named only by the cell beside it', async ({ agent, web }) => {
    await agent.type('the Text Input Field', 'located by the agent');
    await expect(web.locator('#myTextInput')).toHaveValue('located by the agent');
  });

  test('taps a button and judges what it changed', async ({ agent, web }) => {
    await agent.tap('the green Click Me button');
    await expect(web.locator('#pText')).toHaveText('This Text is Purple');
    await agent.assert('the page now says the text is purple');
  });

  test('selects an option in an unlabelled dropdown', async ({ agent, web }) => {
    await agent.select('the Select Dropdown', 'Set to 75%');
    await expect(web.locator('#meterLabel')).toHaveText('HTML Meter: (75%)');
  });

  test('checks and unchecks the pre-checked box', async ({ agent, web }) => {
    await agent.uncheck('the Pre-Check Box');
    await expect(web.locator('#checkBox5')).not.toBeChecked();
    await agent.check('the Pre-Check Box');
    await expect(web.locator('#checkBox5')).toBeChecked();
  });

  test('reveals a hidden row by ticking the first checkbox', async ({ agent, web }) => {
    await agent.check('the CheckBox control in the row labelled "CheckBox:"');
    await expect(web.locator('#drop1')).toBeVisible();
    await agent.assert('a drag and drop row is now visible');
  });

  test('hovers to open a dropdown, then picks a link', async ({ agent, screen }) => {
    await agent.hover('the Hover Dropdown');
    await agent.tap('the Link Two option in the dropdown');
    await expect(screen.getByRole('heading', { name: 'Link Two Selected' })).toBeVisible();
  });

  test('extracts the state of the whole control table', async ({ agent }) => {
    const data = await agent.extract('the read-only field text and the progress bar percentage', {
      schema: z.object({
        readOnlyText: z.string(),
        progressPercent: z.number(),
      }),
    });
    expect(data.readOnlyText).toContain('Green');
    expect(data.progressPercent).toBe(50);
  });

  test(
    'a checkbox inside an embedded document',
    { skip: 'spec 14-security.md denies the data: scheme, so this frame is never observed' },
    async ({ agent, web }) => {
      // The frame is a `data:text/html` document with an opaque origin. The
      // observation walk stops at the boundary node, so the agent has no node to
      // select: the deterministic path reaches this control and the agent cannot.
      await agent.check('the CheckBox inside the iFrame');
      await expect(web.frameLocator('#myFrame3').getByRole('checkbox')).toBeChecked();
    },
  );
});
