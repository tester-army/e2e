/**
 * The agent verbs the hard scenarios never reach, each on the plain control
 * built for it: check, the long press and the double click, a context menu
 * that opens on right-click only, a file input, the browser history, a scroll
 * into view. One step per verb, so a red test names the verb, and a locator
 * check pins each outcome the way the deterministic twin reads it.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const TAGS = { tags: ['control-inventory'] };

test.describe('control inventory', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/control-inventory');
  });

  test('check sets the checkbox and the radio', TAGS, async ({ agent, screen }) => {
    await agent.act('agree to the terms and pick the Medium size');
    await expect(screen.getByLabel('Toggles state')).toHaveText('terms agreed, size Medium');
  });

  test('a long press and a double click are chosen over a plain tap', TAGS, async ({ agent, screen }) => {
    await agent.act('long-press the Hold me button until its state reads long-pressed, then double-click the Double-click me button');
    await expect(screen.getByLabel('Hold state')).toHaveText('long-pressed');
    await expect(screen.getByLabel('Double-click state')).toHaveText('double-clicked');
  });

  test('a right-click opens the file menu and Rename renames the file', TAGS, async ({ agent, screen }) => {
    await agent.act('rename report.pdf to summary.pdf; its menu opens on right-click');
    await expect(screen.getByLabel('File state')).toHaveText('report.pdf renamed to summary.pdf');
  });

  test('upload attaches the named project files', TAGS, async ({ agent, screen }) => {
    await agent.act('attach both files to the Attachments input', {
      params: { files: ['fixtures/attachment.txt', 'fixtures/second.txt'] },
    });
    await expect(screen.getByLabel('Attachments state')).toHaveText('attachment.txt, second.txt');
  });

  test('back returns from the details view to the inventory', TAGS, async ({ agent, screen, browser }) => {
    await agent.act('open the details, then return to the inventory through the browser history');
    await expect(browser).toHaveURL('/e/control-inventory');
    await expect(screen.getByLabel('Navigation state')).toHaveText('back on the inventory');
  });

  test('scroll_to brings the footnote into view', TAGS, async ({ agent, screen }) => {
    await agent.act('bring the Footnote paragraph at the bottom of the page into view');
    await expect(screen.getByLabel('Footnote state')).toHaveText('in view');
  });
});
