import { expect, test } from 'e2e';
import type { Screen } from 'e2e';

/**
 * Edge cases that only a real device surfaces: multi-level navigation, rows
 * below the fold, switch state derived from a platform value, strict
 * cardinality against a repetitive list, and node references surviving (or
 * correctly not surviving) a screen change.
 */

/**
 * Drives Settings to a known root screen.
 *
 * Relaunching resets its navigation stack but not its search field, which
 * Settings persists across launches: a leftover query leaves the root showing a
 * different, longer list with duplicated rows. A mobile suite cannot assume the
 * app resets itself, so each test asserts its starting screen explicitly.
 */
async function resetToRoot({ app, screen }: MobileFixtures): Promise<void> {
  await app.open();
  const search = screen.getByRole('searchbox');
  if ((await search.count()) === 1 && (await search.inputValue()) !== '') {
    await search.clear();
  }
  await expect(screen.getByRole('navigation')).toBeVisible();
}

/** Walks from the Settings root into the Accessibility screen. */
async function openAccessibility(fixtures: MobileFixtures): Promise<void> {
  await resetToRoot(fixtures);
  // iOS repeats a row when the list is long, so the first match is the row.
  await fixtures.screen.getByText('Accessibility').first().tap();
}

/** The fixtures these helpers need, named once. */
type MobileFixtures = {
  app: { open(): Promise<void> };
  screen: Screen;
};

test.describe('Settings navigation depth', () => {
  test('walks three levels deep and back out', async ({ app, screen }) => {
    await openAccessibility({ app, screen });
    await expect(screen.getByText('Motion')).toBeVisible();

    await screen.getByText('Motion').tap();
    await expect(screen.getByText('Reduce Motion')).toBeVisible();

    // The back affordance is the parent screen's title on iOS.
    await app.back();
    await expect(screen.getByText('Display & Text Size')).toBeVisible();

    await app.back();
    await expect(screen.getByText('General')).toBeVisible();
  });

  test('re-resolves a locator across a screen change', async ({ app, screen }) => {
    await resetToRoot({ app, screen });

    // A locator is an expression, not a node handle: the same object resolves
    // against whatever screen is current, so it must survive navigation.
    const rows = screen.getByRole('listitem');
    const rootCount = await rows.count();
    expect(rootCount).toBeGreaterThan(3);

    await screen.getByText('Accessibility').first().tap();
    const nestedCount = await rows.count();
    expect(nestedCount).toBeGreaterThan(0);
  });
});

test.describe('rows below the fold', () => {
  test('an off-screen row is visible but not actionable until scrolled', async ({ app, screen }) => {
    await openAccessibility({ app, screen });

    const offscreen = screen.getByText('Keyboards & Typing');

    // Rendered, so visible: scroll position does not change visibility, which
    // is what web does too.
    await expect(offscreen).toBeVisible();

    // Out of reach, so not actionable: mobile-0.1 never scrolls implicitly.
    const denied = await offscreen
      .tap({ timeout: 5_000 })
      .then(() => null)
      .catch((cause: unknown) => cause);
    expect(denied instanceof Error && denied.message).toContain('scroll it into view');

    // scrollUntilVisible re-resolves each round and stops once it is reachable.
    await screen.scrollUntilVisible(offscreen);
    await offscreen.tap();
    await expect(screen.getByText('Full Keyboard Access')).toBeVisible();
  });

  test('scrollIntoView moves toward a row below the fold', async ({ app, screen }) => {
    await openAccessibility({ app, screen });

    const offscreen = screen.getByText('Live Speech, Off');
    const before = await offscreen.boundingBox();
    await offscreen.scrollIntoView();
    const after = await offscreen.boundingBox();
    // A scroll that reports success without moving anything is the failure
    // mode worth guarding: assert the row actually travelled.
    expect(after?.y).toBeLessThan(before?.y ?? 0);

    await offscreen.tap();
    await expect(screen.getByRole('navigation')).toBeVisible();
  });
});

test.describe('switch state', () => {
  test('derives checked from the platform value and toggles it back', async ({ app, screen }) => {
    await openAccessibility({ app, screen });
    await screen.getByText('Motion').tap();

    // The row's outer switch carries the human label; iOS gives the inner one
    // the raw value as its label, so role plus name is unambiguous.
    const reduceMotion = screen.getByRole('switch', { name: 'Reduce Motion' });
    await expect(reduceMotion).toBeVisible();

    const wasChecked = await reduceMotion.isChecked();

    // Toggle away from wherever the device started, then restore it, so the
    // suite stays idempotent against a real device's persistent settings.
    if (wasChecked) {
      await reduceMotion.uncheck();
      await expect(reduceMotion).not.toBeChecked();
      await reduceMotion.check();
      await expect(reduceMotion).toBeChecked();
    } else {
      await reduceMotion.check();
      await expect(reduceMotion).toBeChecked();
      await reduceMotion.uncheck();
      await expect(reduceMotion).not.toBeChecked();
    }
  });

  test('check is a no-op when the switch already holds the wanted state', async ({ app, screen }) => {
    await openAccessibility({ app, screen });
    await screen.getByText('Motion').tap();

    const target = screen.getByRole('switch', { name: 'Auto-Play Animated Images' });
    const before = await target.isChecked();
    // Toggling an already-correct control would invert it.
    if (before) await target.check();
    else await target.uncheck();
    expect(await target.isChecked()).toBe(before);
  });
});

test.describe('strictness and roles', () => {
  test('an unindexed action on a repeated role fails as ambiguous', async ({ app, screen }) => {
    await openAccessibility({ app, screen });
    await screen.getByText('Motion').tap();

    // The Motion screen is a wall of switches; strict cardinality is the
    // runner's job and must hold on a device too.
    const anySwitch = screen.getByRole('switch');
    expect(await anySwitch.count()).toBeGreaterThan(1);

    const ambiguous = await anySwitch
      .tap({ timeout: 5_000 })
      .then(() => null)
      .catch((cause: unknown) => cause);
    expect(ambiguous instanceof Error && ambiguous.message).toContain('expected exactly one');

    // An explicit index resolves it.
    await expect(anySwitch.first()).toBeVisible();
  });

  test('projects a UIKit link to the link role', async ({ app, screen }) => {
    await openAccessibility({ app, screen });
    await expect(screen.getByRole('link')).toBeVisible();
  });

  test('reads a row whose label carries its state', async ({ app, screen }) => {
    await openAccessibility({ app, screen });

    // iOS folds a row's value into its accessibility label.
    const hoverText = screen.getByText('Hover Text, Off');
    expect(await hoverText.textContent()).toContain('Off');
  });
});

test.describe('search field', () => {
  test('filters the list and clears back to it', async ({ app, screen }) => {
    await resetToRoot({ app, screen });

    const search = screen.getByRole('searchbox');
    await search.fill('motion');
    expect(await search.inputValue()).toContain('motion');

    // Clearing is not politeness: Settings persists the query, so leaving it
    // set changes the root screen every later run observes. The keyboard is
    // left alone on purpose: a Settings search field exposes no native dismiss
    // control, so `device.hideKeyboard` reports UNSUPPORTED_CAPABILITY there,
    // and relaunching is what actually clears it.
    await search.clear();
    expect(await search.inputValue()).toBe('');
    await expect(screen.getByText('General').first()).toBeVisible();
  });
});
