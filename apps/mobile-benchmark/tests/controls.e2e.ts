/**
 * Every deterministic verb, read, and matcher on the Control Inventory
 * scenario: plain controls with every state exposed, so a verb that fails
 * here fails on the device or in the engine, never in the app. Each state
 * assertion pairs with the status line the app prints.
 */

import type { Screen } from 'e2e';
import { expect, openScenario, test } from './fixtures.ts';

/** What a rejected promise carried, for asserting on its error code. */
async function rejection(promise: Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  return promise.then(
    () => undefined,
    (error: unknown) => error as { code?: string; message?: string },
  );
}

/** Shows one of the scenario's three sections; every control of it fits on screen. */
async function showSection(screen: Screen, name: 'Fields' | 'Toggles' | 'Gestures'): Promise<void> {
  await screen.getByTestId(`tab-${name.toLowerCase()}`).tap();
}

test.describe('control inventory', () => {
  test.beforeEach(async ({ app, device, screen }) => {
    await openScenario({ app, device, screen }, 'Control Inventory');
  });

  // iOS reports a React Native text input twice, as a host view and the
  // field inside it, both carrying the label; a label query answers with the
  // field, the innermost match, as a text query does.
  test('a label query resolves a labeled text field', async ({ screen }) => {
    await expect(screen.getByLabel('Name field')).toHaveValue('Ada Lovelace');
    await expect(screen.getByLabel(/^Name/)).toHaveAccessibleName('Name field');
  });

  test('a labeled field answers name, display value, value reads, fill, and clear', async ({ screen }) => {
    const name = screen.getByRole('textbox', 'Name field');
    await expect(name).toHaveValue('Ada Lovelace');
    await expect(screen.getByDisplayValue('Ada Lovelace')).toHaveAccessibleName('Name field');
    expect(await name.inputValue()).toBe('Ada Lovelace');

    await name.fill('Grace Hopper');
    await expect(name).toHaveValue('Grace Hopper');
    await expect(screen.getByTestId('name-echo')).toHaveText('name: Grace Hopper');

    await name.clear();
    // XCTest reports an empty field's placeholder as its value and flags
    // nothing, so on a host without the simulator's accessibility bridge the
    // echo is what says the field is empty.
    await expect(screen.getByTestId('name-echo')).toHaveText('name:');
    await name.press('Enter');
  });

  test('a placeholder query and attribute reads find the field', async ({ screen }) => {
    await expect(screen.getByPlaceholder('Type your name')).toHaveValue('Ada Lovelace');
    await expect(screen.getByTestId('name-input')).toHaveAttribute('placeholder', 'Type your name');
    expect(await screen.getByTestId('name-input').getAttribute('placeholder')).toBe('Type your name');
  });

  // The keyboard stays up on purpose: Return on a secure field makes iOS
  // offer to save the password, a sheet the next test never sees because
  // every attempt relaunches the app.
  test('a secure field takes a fill and denies value reads', async ({ screen }) => {
    const passphrase = screen.getByTestId('passphrase-input');
    await passphrase.fill('correct horse');
    await expect(screen.getByTestId('passphrase-length')).toHaveText('passphrase length: 13');
    expect((await rejection(passphrase.inputValue()))?.code).toBe('POLICY_DENIED');
    expect((await rejection(passphrase.allTextContents()))?.code).toBe('POLICY_DENIED');
  });

  test('press sends a character and Enter through the soft keyboard', async ({ screen }) => {
    const key = screen.getByTestId('key-input');
    await key.press('a');
    await expect(screen.getByTestId('key-status')).toHaveText('key: a');
    await expect(key).toHaveValue('a');
    await key.press('Enter');
    await expect(screen.getByTestId('key-status')).toHaveText('key: Enter');
  });

  test('a field autofocuses on mount and focus() moves the focus', async ({ screen }) => {
    await screen.getByRole('button', 'Show focus fields').tap();
    const status = screen.getByTestId('focus-status');
    await expect(status).toHaveText('focus: Autofocus field');

    const second = screen.getByRole('textbox', 'Second field');
    await second.focus();
    await expect(status).toHaveText('focus: Second field');

    await screen.getByRole('textbox', 'Autofocus field').focus();
    await expect(status).toHaveText('focus: Autofocus field');

    await screen.getByRole('textbox', 'Autofocus field').press('Enter');
    await expect(status).toHaveText('focus: none');
  });

  test('toBeFocused follows the focus', async ({ screen }) => {
    await screen.getByRole('button', 'Show focus fields').tap();
    const first = screen.getByRole('textbox', 'Autofocus field');
    const second = screen.getByRole('textbox', 'Second field');
    await expect(first).toBeFocused();
    await second.focus();
    await expect(second).toBeFocused();
    await expect(first).not.toBeFocused();
  });

  test('a switch checks, unchecks, and reports its state', async ({ screen }) => {
    await showSection(screen, 'Toggles');
    const wifi = screen.getByTestId('wifi-switch');
    await expect(wifi).toHaveAccessibleName('Wi-Fi switch');
    expect(await wifi.isChecked()).toBe(false);
    await expect(wifi).not.toBeChecked();

    await wifi.check();
    await expect(wifi).toBeChecked();
    expect(await wifi.isChecked()).toBe(true);
    await expect(screen.getByTestId('wifi-status')).toHaveText('wifi: on');
    // Already on: a second check sends nothing and leaves it on.
    await wifi.check();
    await expect(screen.getByTestId('wifi-status')).toHaveText('wifi: on');

    await wifi.uncheck();
    await expect(wifi).not.toBeChecked();
    await expect(screen.getByTestId('wifi-status')).toHaveText('wifi: off');
  });

  // React Native gives the checkbox and radio roles no UIKit trait and spells
  // them into the accessibility value instead ("checkbox, unchecked"); the
  // engine reads the role back, so a role query finds them on both platforms.
  test('checkbox and radio roles answer getByRole, and a checkbox toggles by tap', async ({ screen }) => {
    await showSection(screen, 'Toggles');
    await expect(screen.getByRole('radio')).toHaveCount(3);
    await expect(screen.getByRole('radio', 'Medium')).toBeVisible();
    const newsletter = screen.getByRole('checkbox', 'Newsletter');
    await expect(newsletter).toBeVisible();
    await expect(screen.getByRole('checkbox')).toHaveCount(1);
    await expect(screen.getByLabel('Newsletter')).toHaveAccessibleName('Newsletter');

    await newsletter.tap();
    await expect(screen.getByTestId('newsletter-status')).toHaveText('newsletter: on');
    await newsletter.tap();
    await expect(screen.getByTestId('newsletter-status')).toHaveText('newsletter: off');
  });

  // The state words after the role ("checked", "unchecked") are the checked
  // state on iOS.
  test('checkbox and radio roles check, uncheck, and report their state', async ({ screen }) => {
    await showSection(screen, 'Toggles');
    const newsletter = screen.getByRole('checkbox', 'Newsletter');
    await expect(newsletter).not.toBeChecked();
    expect(await newsletter.isChecked()).toBe(false);

    await newsletter.check();
    await expect(newsletter).toBeChecked();
    expect(await newsletter.isChecked()).toBe(true);
    await expect(screen.getByTestId('newsletter-status')).toHaveText('newsletter: on');
    // Already on: a second check sends nothing and leaves it on.
    await newsletter.check();
    await expect(screen.getByTestId('newsletter-status')).toHaveText('newsletter: on');

    await newsletter.uncheck();
    await expect(newsletter).not.toBeChecked();
    await expect(screen.getByTestId('newsletter-status')).toHaveText('newsletter: off');

    const small = screen.getByRole('radio', 'Small');
    const medium = screen.getByRole('radio', 'Medium');
    await expect(small).toBeChecked();
    await expect(medium).not.toBeChecked();
    await medium.check();
    await expect(medium).toBeChecked();
    await expect(small).not.toBeChecked();
    await expect(screen.getByTestId('size-status')).toHaveText('size: Medium');
  });

  // React Native 0.86 gives the tab role no UIKit trait and, unlike checkbox
  // and radio, spells nothing into the accessibility value on the new
  // architecture, so an iOS tab is an Other carrying only the selected trait.
  // On Android it is a plain View whose role description (`Tab`) agent-device
  // 0.21.14 carries and the engine reads.
  test('a tab role answers getByRole', { platforms: ['android'] }, async ({ screen }) => {
    await expect(screen.getByRole('tab')).toHaveCount(4);
  });

  // A radio's state is `checked`: React Native spells it into the iOS value.
  // The `selected` trait beside it only reaches the tree through the
  // simulator's accessibility bridge, which a CI Mac does not always provide,
  // so it is not what a radio is read by.
  test('a radio group reports the checked option', async ({ screen }) => {
    await showSection(screen, 'Toggles');
    const sizes = screen.getByLabel(/^(Small|Medium|Large)$/);
    await expect(sizes).toHaveCount(3);
    await expect(screen.getByTestId('size-small')).toBeChecked();
    await expect(screen.getByTestId('size-medium')).not.toBeChecked();

    await screen.getByTestId('size-medium').tap();
    await expect(screen.getByTestId('size-medium')).toBeChecked();
    await expect(screen.getByTestId('size-small')).not.toBeChecked();
    await expect(screen.getByTestId('size-status')).toHaveText('size: Medium');
  });

  test('buttons report disabled, enabled, and a state that arrives later', async ({ screen }) => {
    await showSection(screen, 'Toggles');
    const locked = screen.getByRole('button', 'Locked');
    await expect(locked).toBeDisabled();
    expect(await locked.isDisabled()).toBe(true);
    expect(await locked.isEnabled()).toBe(false);

    const delayed = screen.getByRole('button', 'Delayed');
    await expect(delayed).toBeEnabled();
    expect(await delayed.isEnabled()).toBe(true);
    await expect(screen.getByTestId('delayed-status')).toHaveText('delayed: ready');
    await delayed.tap();
    await expect(screen.getByTestId('delayed-status')).toHaveText('delayed: pressed');
  });

  // iOS leaves a `display: none` view out of the accessibility tree rather
  // than marking it hidden, so the ghost is absent (count 0, not attached)
  // and its twin the one match.
  test('a display: none element is absent rather than hidden, its visible twin attached', async ({ screen }) => {
    await showSection(screen, 'Toggles');
    const ghost = screen.getByTestId('ghost-text');
    await expect(ghost).toBeHidden();
    expect(await ghost.isHidden()).toBe(true);
    await expect(ghost).not.toBeAttached();
    await expect(ghost).toHaveCount(0);

    const twin = screen.getByTestId('twin-text');
    await expect(twin).toBeAttached();
    await expect(twin).toBeVisible();
    await expect(screen.getByText('Now you see me', { visible: true })).toHaveText('Now you see me');
    await expect(screen.getByText('Now you see me')).toHaveCount(1);
    await expect(screen.getByTestId('ghost-text', { visible: true })).toHaveCount(0);
  });

  test('a header answers its accessible name', async ({ screen }) => {
    await expect(screen.getByTestId('inventory-header')).toHaveAccessibleName('Inventory heading');
    await expect(screen.getByTestId('inventory-header')).toHaveAccessibleName(/heading$/);
  });

  // Which tab is selected shows in the section it reveals. iOS gives a React
  // Native tab no trait, and its `selected` state only reaches the tree
  // through the simulator's accessibility bridge, which a CI Mac does not
  // always provide; the section content is the same fact on every host.
  test('a tab row answers count, all, texts, filters, positions, and switching', async ({ screen }) => {
    const tabs = screen.getByLabel(/^(Fields|Toggles|Gestures)$/);
    await expect(tabs).toHaveCount(3);
    expect(await tabs.count()).toBe(3);
    expect(await tabs.allTextContents()).toEqual(['Fields', 'Toggles', 'Gestures']);
    await expect(tabs).toHaveText(['Fields', 'Toggles', 'Gestures']);
    await expect(tabs).toContainText(['Fie', 'Tog', 'Ges']);
    await expect(tabs.first()).toContainText('Fiel');
    await expect(screen.getByTestId('name-input')).toBeVisible();
    await expect(screen.getByTestId('wifi-status')).toHaveCount(0);

    await tabs.nth(1).tap();
    await expect(screen.getByTestId('wifi-status')).toBeVisible();
    await expect(screen.getByTestId('name-input')).toHaveCount(0);

    await tabs.filter({ hasText: 'Gestures' }).tap();
    await expect(screen.getByTestId('gesture-status')).toBeVisible();
    await expect(screen.getByTestId('wifi-status')).toHaveCount(0);

    const each = await tabs.all();
    expect(each).toHaveLength(3);
    expect(await each[2]!.textContent()).toBe('Gestures');
  });

  // iOS reports React Native views as leaf siblings of their children, so a
  // row never contains its texts. The scenario's scroll view is a container
  // the tree does nest on both platforms.
  test('a list answers counts, list-form text, reads, and boxes in order', async ({ screen }) => {
    await showSection(screen, 'Gestures');
    const rows = screen.getByTestId('fruit-row');
    await expect(rows).toHaveCount(3);
    const names = screen.getByText(/^(Apple|Banana|Cherry)$/);
    await expect(names).toHaveText(['Apple', 'Banana', 'Cherry']);
    await expect(names).toContainText(['App', 'nan', 'err']);
    expect(await names.allTextContents()).toEqual(['Apple', 'Banana', 'Cherry']);
    expect(await names.nth(1).textContent()).toBe('Banana');
    expect(await names.first().textContent()).toBe('Apple');
    expect(await names.last().textContent()).toBe('Cherry');

    const page = screen.getByTestId('inventory-scroll');
    await expect(page.filter({ has: screen.getByTestId('fruit-list') })).toHaveCount(1);
    await expect(page.getByText(/^\$/)).toHaveText(['$1', '$2', '$3']);
    await expect(page.filter({ hasText: 'Cherry' })).toHaveCount(1);
    await expect(page.filter({ hasText: 'Durian' })).toHaveCount(0);
    await expect(page.filter({ has: screen.getByText('Banana') })).toHaveCount(1);
    await expect(page.filter({ has: screen.getByText('Durian') })).toHaveCount(0);

    const first = await rows.first().boundingBox();
    const last = await rows.last().boundingBox();
    if (first === null || last === null) throw new Error('rows have no box');
    expect(first.height).toBeGreaterThan(0);
    expect(first.width).toBeGreaterThan(0);
    expect(last.y).toBeGreaterThan(first.y + first.height - 1);
    expect(last.x).toBe(first.x);
  });

  test(
    'a row contains its texts',
    {
      skip: 'React Native flattens a plain View out of the accessibility tree on both platforms: XCTest and the Android helper report a View with a testID as a leaf beside its children, so filter({ has }) and a query scoped to it match nothing; only ScrollView, TextInput, and Text hosts nest',
    },
    async ({ screen }) => {
      await showSection(screen, 'Gestures');
      await expect(screen.getByTestId('fruit-row').filter({ has: screen.getByText('Banana') })).toHaveCount(1);
      await expect(screen.getByTestId('fruit-list').getByText(/^\$/)).toHaveCount(3);
    },
  );

  test('a long press lands as one', async ({ screen }) => {
    await showSection(screen, 'Gestures');
    await screen.getByRole('button', 'Hold me').longPress({ duration: 800 });
    await expect(screen.getByTestId('gesture-status')).toHaveText('gesture: long press');
  });

  // The engine sends a double tap as two presses, since agent-device's own
  // double-tap gesture reaches a Pressable as one press. The app prints how
  // many taps arrived and how far apart, so a pair that missed the window
  // shows what the device delivered.
  // agent-device 0.21.13's iOS runner lands two presses 284 to 285 ms apart
  // (its XCTest tap cadence: press --count 2; 401 ms with --interval-ms 120)
  // and its --double-tap gesture reaches a Pressable as one press, so on iOS
  // the scenario's 300 ms window has no margin and reads the pair as two
  // single taps on a loaded machine. Android lands the pair inside it.
  test('a double tap lands inside the 300 ms window', { platforms: ['android'] }, async ({ screen }) => {
    await showSection(screen, 'Gestures');
    await screen.getByRole('button', 'Double-tap me').doubleTap();
    await expect(screen.getByTestId('tap-count')).toContainText('2 taps');
    await expect(screen.getByTestId('gesture-status')).toHaveText('gesture: double tap');
  });

  // Android bounds and points are the screen's physical pixels: agent-device
  // 0.21.15 reports the emulator's display density in its snapshot metadata,
  // but rects and points stay physical pixels and the engine does not scale
  // them yet, so the pad's 240 by 100 reads as 630 by 263 on a 2.625x emulator.
  test('pointer verbs land at the point asked for', { platforms: ['ios'] }, async ({ screen }) => {
    await showSection(screen, 'Gestures');
    const pad = screen.getByLabel('Tap pad');
    const box = await pad.boundingBox();
    if (box === null) throw new Error('pad has no box');
    expect(box.width).toBe(240);
    expect(box.height).toBe(100);

    await screen.tapAt({ x: box.x + 40, y: box.y + 30 });
    await expect(screen.getByTestId('pad-status')).toHaveText('pad: 40,30');

    await pad.tap({ position: { x: 200, y: 90 } });
    await expect(screen.getByTestId('pad-status')).toHaveText('pad: 200,90');

    await pad.tap();
    await expect(screen.getByTestId('pad-status')).toHaveText('pad: 120,50');

    const swipePad = screen.getByTestId('swipe-pad');
    const swipeBox = await swipePad.boundingBox();
    if (swipeBox === null) throw new Error('swipe pad has no box');
    // A left-to-right fling anywhere on the screen pops it (the stack's back
    // gesture, wherever it starts), so the path runs right to left. The
    // finger goes down exactly at `from`; agent-device swipes as a fling that
    // lifts about 10 pt short of `to` (111 for 100 here), hence the tolerance.
    await screen.swipe({
      from: { x: swipeBox.x + 300, y: swipeBox.y + 40 },
      to: { x: swipeBox.x + 100, y: swipeBox.y + 40 },
    });
    const swipeStatus = screen.getByTestId('swipe-status');
    await expect(swipeStatus).toContainText('swipe: 300,40 to ');
    const path = /^swipe: 300,40 to (\d+),40$/.exec((await swipeStatus.textContent()) ?? '');
    if (path === null) throw new Error('swipe status has no path');
    expect(Math.abs(Number(path[1]) - 100)).toBeLessThanOrEqual(15);

    // `direction` is the scroll direction: content to the right comes into
    // view when the finger moves left, so the end lands left of the start.
    await swipePad.swipe({ direction: 'right' });
    await expect
      .poll(async () => {
        const status = await swipeStatus.textContent();
        const match = /^swipe: (\d+),\d+ to (-?\d+),\d+$/.exec(status ?? '');
        return match === null ? status : Number(match[2]) < Number(match[1]);
      })
      .toBe(true);
  });

  test('an ambiguous locator fails at once', async ({ screen }) => {
    await showSection(screen, 'Gestures');
    const ambiguous = await rejection(screen.getByTestId('fruit-row').tap());
    expect(ambiguous?.code).toBe('LOCATOR_AMBIGUOUS');
  });

  test('screenshot, restart, and clearState reopen the app on its home list', async ({ app, screen }) => {
    const shot = await app.screenshot('inventory');
    expect(shot).toMatch(/^screenshots\/\d{3}-inventory\.png$/);

    await app.restart();
    await expect(screen.getByTestId('Login Form')).toBeVisible();
    await expect(screen.getByTestId('inventory-header')).toBeHidden();

    await app.clearState();
    await expect(screen.getByTestId('Login Form')).toBeVisible();
  });
});

test.describe('refusals', () => {
  test('verbs a device never declares are refused before the engine', async ({ screen }) => {
    const row = screen.getByTestId('Login Form');
    for (const attempt of [
      () => row.selectOption('Small'),
      () => row.scrollIntoView(),
      () => row.secondaryTap(),
      () => row.setInputFiles('assets/icon.png'),
    ]) {
      const refused = await rejection(attempt());
      expect(refused?.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(refused?.message).toContain('is not available on this target');
    }
  });

  test('keys the soft keyboard cannot send are refused by the engine', async ({ screen }) => {
    const row = screen.getByTestId('Login Form');
    await expect(row).toBeVisible();
    const modifier = await rejection(row.press('Control+a'));
    expect(modifier?.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(modifier?.message).toContain('cannot hold Control');
    const named = await rejection(row.press('Escape'));
    expect(named?.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(named?.message).toContain('cannot press Escape');
  });

  test('a missing locator fails as not found once its timeout passes', async ({ screen }) => {
    await expect(screen.getByTestId('Login Form')).toBeVisible();
    const missing = await rejection(screen.getByTestId('no-such-control').tap({ timeout: 1_000 }));
    expect(missing?.code).toBe('LOCATOR_NOT_FOUND');
  });
});
