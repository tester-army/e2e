import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { boxOf, failure } from './helpers.ts';

test.describe('controls', { requires: ['web'], tags: ['controls'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/controls');
  });

  test('a secondary tap opens the context menu', async ({ screen }) => {
    const menu = screen.getByRole('menu', { name: 'File actions' });
    const state = screen.getByRole('status', { name: 'File state' });
    await expect(menu).toBeHidden();

    await screen.getByText('report.pdf', { exact: true }).secondaryTap();
    await expect(menu).toBeVisible();
    await expect(state).toHaveText('menu open');
    await expect(menu.getByRole('menuitem')).toHaveCount(2);

    await menu.getByRole('menuitem', { name: 'Rename' }).tap();
    await expect(state).toHaveText('renamed');
    await expect(menu).toBeHidden();
  });

  test('a long press and a double tap are told apart from a tap', async ({ screen }) => {
    const gesture = screen.getByRole('status', { name: 'Gesture state' });
    const hold = screen.getByRole('button', { name: 'Hold me' });

    await hold.tap();
    await expect(gesture).toHaveText('tapped');
    await hold.longPress({ duration: 700 });
    await expect(gesture).toHaveText('long-pressed');
    await screen.getByRole('button', { name: 'Tap me twice' }).doubleTap();
    await expect(gesture).toHaveText('double-tapped');
  });

  test('expanded state follows the disclosure toggle', async ({ screen }) => {
    const toggle = screen.getByRole('button', { name: 'Details' });
    await expect(toggle).not.toBeExpanded();
    await expect(screen.getByText('The fine print.')).toBeHidden();
    await expect(screen.getByRole('button', { name: 'Details', expanded: false })).toHaveCount(1);

    await toggle.tap();
    await expect(toggle).toBeExpanded();
    await expect(screen.getByText('The fine print.')).toBeVisible();
    await expect(screen.getByRole('button', { name: 'Details', expanded: true })).toHaveCount(1);
  });

  test('enabled state arrives late and every read agrees', async ({ screen }) => {
    const publish = screen.getByRole('button', { name: 'Publish' });
    await expect(publish).toBeDisabled();
    expect(await publish.isDisabled()).toBe(true);
    expect(await publish.isEnabled()).toBe(false);
    await expect(screen.getByRole('button', { name: 'Publish', disabled: true })).toHaveCount(1);

    await screen.getByRole('button', { name: 'Prepare' }).tap();
    await expect(publish).toBeEnabled();
    await expect.poll(() => publish.isEnabled()).toBe(true);
    expect(await publish.isDisabled()).toBe(false);
    await expect(screen.getByRole('button', { name: 'Publish', disabled: false })).toHaveCount(1);
  });

  test('check and uncheck move checked state, and one radio checks at a time', async ({ screen }) => {
    const agree = screen.getByLabel('Agree to terms');
    expect(await agree.isChecked()).toBe(false);
    await agree.check();
    await expect(agree).toBeChecked();
    expect(await agree.isChecked()).toBe(true);
    await agree.uncheck();
    await expect(agree).not.toBeChecked();

    await expect(screen.getByRole('radio', { checked: true })).toHaveCount(0);
    await screen.getByRole('radio', { name: 'Medium' }).check();
    await expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked();
    await expect(screen.getByRole('radio', { name: 'Small' })).not.toBeChecked();
    await expect(screen.getByRole('radio', { checked: true })).toHaveCount(1);
    expect(await screen.getByRole('radio', { name: 'Large' }).isChecked()).toBe(false);
  });

  test('selecting an option moves selected state onto it', async ({ screen }) => {
    const color = screen.getByLabel('Color');
    await expect(screen.getByRole('option', { name: 'Green' })).toBeSelected();
    await expect(screen.getByRole('option', { name: 'Blue' })).not.toBeSelected();

    await color.selectOption('Blue');
    await expect(color).toHaveValue('blue');
    await expect(screen.getByRole('option', { name: 'Blue' })).toBeSelected();
    await expect(screen.getByRole('option', { name: 'Green' })).not.toBeSelected();
    await expect(screen.getByRole('option', { selected: true })).toHaveText('Blue');
  });

  test('focus moves with Tab and Shift+Tab', async ({ screen }) => {
    const first = screen.getByLabel('First');
    const second = screen.getByLabel('Second');

    await first.focus();
    await expect(first).toBeFocused();
    await expect(second).not.toBeFocused();

    await first.press('Tab');
    await expect(second).toBeFocused();
    await expect(first).not.toBeFocused();

    await second.press('Shift+Tab');
    await expect(first).toBeFocused();
  });

  test('press spells modifiers the way the app sees them', async ({ screen }) => {
    const keys = screen.getByLabel('Key log input');
    const log = screen.getByLabel('Key log');

    await keys.press('Shift+ArrowLeft');
    await expect(log).toHaveText('Shift+ArrowLeft');
    await keys.press('Control+a');
    await expect(log).toHaveText('Control+a');
    await keys.press('Alt+Shift+Enter');
    await expect(log).toHaveText('Alt+Shift+Enter');
    // A lone character is pressed as itself: no modifier is held for it, whatever the layout needs.
    await keys.press('$');
    await expect(log).toHaveText('$');
    await keys.press('Escape');
    await expect(log).toHaveText('Escape');
  });

  test('a link reads back its attributes, accessible name, classes, and text', async ({ screen, web }) => {
    const docs = screen.getByRole('link', { name: 'Documentation' });
    await expect(docs).toHaveAttribute('data-kind', 'external');
    await expect(docs).toHaveAttribute('href');
    await expect(docs).toHaveAttribute('href', /about$/);
    await expect(docs).not.toHaveAttribute('hidden');
    await expect(docs).toHaveAccessibleName('Documentation');
    await expect(docs).toHaveText('Docs');
    await expect(web).toHaveClass(docs, 'link primary');
    await expect(web).toHaveClass(docs, /primary/);
    await expect(web).not.toHaveClass(docs, /secondary/);

    expect(await docs.getAttribute('data-kind')).toBe('external');
    expect(await docs.getAttribute('data-missing')).toBeNull();
    expect(await docs.textContent()).toBe('Docs');
  });

  test('a hidden twin is skipped by a visible query and reached by index', async ({ screen }) => {
    const banner = screen.getByTestId('banner');
    await expect(banner).toHaveCount(2);
    expect(await failure(() => banner.tap({ timeout: 500 }))).toHaveProperty('code', 'LOCATOR_AMBIGUOUS');

    await expect(screen.getByTestId('banner', { visible: true })).toHaveCount(1);
    await expect(screen.getByTestId('banner', { visible: true })).toBeVisible();
    await expect(screen.getByText('Sale', { visible: true })).toHaveText('Sale');

    await expect(banner.first()).toBeHidden();
    await expect(banner.first()).toBeAttached();
    expect(await banner.first().isHidden()).toBe(true);
    await expect(banner.last()).toBeVisible();
    expect(await banner.last().isVisible()).toBe(true);
  });

  test('filters narrow a list by text or a nested match, and nth picks one row', async ({ screen }) => {
    const tickets = screen.getByRole('list', { name: 'Tickets' }).getByRole('listitem');
    await expect(tickets).toHaveCount(3);
    await expect(tickets.filter({ has: screen.getByText('urgent') })).toHaveCount(2);
    await expect(tickets.filter({ has: screen.getByRole('button') })).toHaveCount(2);
    await expect(tickets.filter({ hasText: 'Ticket B' })).toHaveCount(1);
    await expect(
      tickets.filter({ has: screen.getByText('urgent') }).filter({ has: screen.getByRole('button') }),
    ).toContainText('Ticket A');
    await expect(tickets.nth(1)).toContainText('Ticket B');
    await expect(tickets.nth(2).getByRole('button')).toHaveCount(0);
    expect(await tickets.allTextContents()).toHaveLength(3);
    expect(await tickets.all()).toHaveLength(3);

    expect(await failure(() => tickets.filter({}))).toHaveProperty('code', 'INVALID_LOCATOR');
    expect(await failure(() => tickets.nth(-1))).toHaveProperty('code', 'INVALID_LOCATOR');
  });

  test('display value queries follow the value', async ({ screen }) => {
    await expect(screen.getByDisplayValue('SAVE10')).toBeVisible();
    await expect(screen.getByDisplayValue('SAVE10')).toHaveValue('SAVE10');

    await screen.getByLabel('Coupon').fill('FREESHIP');
    await expect(screen.getByDisplayValue('SAVE10')).toHaveCount(0);
    await expect(screen.getByDisplayValue('FREESHIP')).toHaveValue('FREESHIP');
    expect(await screen.getByLabel('Coupon').inputValue()).toBe('FREESHIP');
  });

  test('several files reach a multiple file input', async ({ screen }) => {
    await screen.getByLabel('Attachments').setInputFiles(['fixtures/attachment.txt', 'fixtures/second.txt']);
    await expect(screen.getByLabel('Attachments state')).toHaveText('attachment.txt, second.txt');
  });

  test('scrollIntoView brings a node far below into the viewport', async ({ screen }) => {
    const footnote = screen.getByText('Footnote', { exact: true });
    await expect(screen.getByLabel('Footnote state')).toHaveText('out of view');

    await footnote.scrollIntoView();
    await expect(screen.getByLabel('Footnote state')).toHaveText('in view');
    expect((await boxOf(footnote)).y).toBeGreaterThanOrEqual(0);
  });

  test('a missing locator fails as LOCATOR_NOT_FOUND after its timeout', async ({ screen }) => {
    expect(await failure(() => screen.getByRole('button', { name: 'Nope' }).tap({ timeout: 500 }))).toHaveProperty(
      'code',
      'LOCATOR_NOT_FOUND',
    );
    await expect(screen.getByRole('button', { name: 'Nope' })).toHaveCount(0);
    expect(await screen.getByRole('button', { name: 'Nope' }).count()).toBe(0);
  });
});
