/**
 * `agent.act()` against every scenario, one step each: the step gets the
 * catalog description as its goal and reads the rest off the screen; the
 * deterministic check on the scenario's success message decides the test.
 * Scenarios the harness cannot finish yet are declared and skipped with the
 * reason, so the gap stays visible in every run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Device } from '@e2edev/mobile';
import type { Agent, AgentParam, Screen } from 'e2e';
import { credentials } from 'e2e';
import { expect, openScenario, test } from '../tests/fixtures.ts';

interface Scenario {
  /** The home-list row, which is also the scenario's screen title. */
  readonly name: string;
  readonly goal: string;
  /** What `success-message` shows at the end; a pattern when the message carries run-time data. */
  readonly success: string | RegExp;
  /**
   * Why the harness cannot finish this scenario yet. The test is declared and
   * skipped with the reason, and turns on the day the capability lands.
   */
  readonly gap?: string;
  /** The platforms whose fixture the scenario depends on; both by default. */
  readonly platforms?: readonly ('ios' | 'android')[];
  /** A step budget above the default, for a flow that legitimately needs more actions. */
  readonly maxSteps?: number;
  /**
   * The screen's tree is merged or hidden on purpose, so the success message
   * never enters it: the goal tells the model the screen lists nothing and
   * success is judged from a screenshot.
   */
  readonly pixels?: true;
  /** Puts the device in the state the scenario expects before it opens. */
  readonly prepare?: () => void;
  /** Values the goal refers to; a `Secret` is filled by the runner, never shown to the model. */
  readonly params?: () => Readonly<Record<string, AgentParam>>;
}

/**
 * The photo the picker scenario expects in the library, added once to every
 * booted simulator. A marker in the simulator's own data directory keeps a
 * rerun from adding a copy, which would leave the picker with twins the
 * trace cache cannot tell apart, and goes with the library when the
 * simulator is erased.
 */
function seedReceiptPhoto(): void {
  const photo = resolve(import.meta.dirname, '../assets/icon.png');
  const booted = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' });
  const devices = JSON.parse(booted) as { devices: Record<string, { udid: string; state: string; dataPath: string }[]> };
  for (const runtime of Object.values(devices.devices)) {
    for (const device of runtime) {
      if (device.state !== 'Booted') continue;
      const marker = resolve(device.dataPath, 'tmp', 'e2e-mobile-benchmark-receipt');
      if (existsSync(marker)) continue;
      execFileSync('xcrun', ['simctl', 'addmedia', device.udid, photo]);
      writeFileSync(marker, photo);
    }
  }
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'Login Form',
    // The hint on screen shows the declared credential, which reaches the
    // model redacted, so the account comes in as params instead.
    goal: 'log in with the given username and password',
    success: 'Logged in successfully',
    params: () => {
      const account = credentials.user('benchmark');
      return { username: account.username, password: account.password };
    },
  },
  {
    name: 'Infinite Scroll List',
    goal: 'scroll the paginated list until Item 137 appears, then tap it',
    success: 'Found item 137',
    // Item 137 is the fifth page; that is a few dozen scrolls, more than the
    // default action budget.
    maxSteps: 60,
  },
  {
    name: 'Modal Flow',
    goal: 'open the modal, continue, and confirm the alert that follows',
    success: 'Flow completed',
  },
  {
    name: 'Bottom Tabs',
    goal: 'go to the Actions tab and complete the action there',
    success: 'Action completed',
  },
  {
    name: 'Text Input Variations',
    goal: 'fill the username, the 4-digit PIN, and at least ten characters of notes, then submit',
    success: 'Form submitted',
  },
  {
    name: 'Broken Accessibility',
    goal: 'complete the flow the screen describes until it says Access granted',
    success: 'Access granted',
    pixels: true,
  },
  {
    name: 'Vision Only',
    goal: 'complete the flow the screen describes until it says Sequence complete',
    success: 'Sequence complete',
    pixels: true,
  },
  {
    name: 'Gestures',
    goal: 'long-press the first target, swipe the card left, then double-tap the last target',
    success: 'All gestures completed',
    gap: 'long-press and double-tap have no grammar verb; only the device tool pack swipes',
  },
  {
    name: 'Async States',
    goal: 'wait for the screen to load, pull to refresh, then claim the reward',
    success: 'Reward claimed',
  },
  {
    name: 'Debounced Search',
    goal: 'search for Benchmark Target and select exactly that result once it loads',
    success: 'Selected Benchmark Target',
  },
  {
    name: 'Huge Virtualized List',
    goal: 'scroll to Row 0512 and tap it; the list has 600 rows of equal height and off-screen rows are not in the tree, so scroll many screens at a time',
    success: 'Found Row 0512',
    maxSteps: 80,
  },
  {
    name: 'Flattened Registration Form',
    goal: 'fill every field of the registration form with plausible values and sign up until it says Account created',
    success: 'Account created',
    pixels: true,
  },
  {
    name: 'Flattened Login',
    goal: 'log in with the email and password the screen shows as a hint',
    success: 'Logged in successfully',
    pixels: true,
  },
  {
    name: 'Sticky Chrome Target',
    goal: 'scroll down to the Accept terms button under the sticky footer, accept the terms, then tap Continue in the footer',
    success: 'Terms accepted',
  },
  {
    name: 'WebView Accessibility',
    goal: 'read the coupon code inside the web view, enter it in the web form, accept the terms, and apply it',
    success: 'Coupon applied',
  },
  {
    name: 'Permission Prompt',
    goal: 'request microphone access and allow it in the system dialog',
    success: 'Microphone enabled',
  },
  {
    name: 'Photo Picker',
    goal: 'choose a photo and pick the most recent one from the library so it is attached as the receipt',
    success: /^Receipt attached/,
    // The receipt is seeded with `xcrun simctl addmedia`; the emulator's
    // seeding (adb push and a media scan) is not written yet.
    platforms: ['ios'],
    prepare: seedReceiptPhoto,
  },
  {
    name: 'Product Catalog',
    goal: 'open Trail Mix 500 g (not a look-alike), set the quantity to 2, add it to the cart, then open the cart',
    success: 'Order ready: 2 × Trail Mix 500 g',
  },
  {
    name: 'Error Recovery',
    goal: 'retry the failed load, then delete the draft and confirm',
    success: 'Draft deleted',
  },
  {
    name: 'Choice Controls',
    goal: 'order a Medium pizza with exactly Cheese and Olives, enable rush delivery, dismiss the keyboard, and place the order',
    success: 'Order placed: Medium with Cheese, Olives (rush)',
  },
  {
    name: 'Stripe PaymentSheet',
    goal: 'open the checkout and pay with the Stripe test card 4242 4242 4242 4242, any future expiry, any CVC',
    success: 'Stripe test payment completed',
    maxSteps: 40,
  },
  {
    name: 'Sequential Onboarding',
    goal: 'complete the signup wizard with the email, name, and phone the screen asks for, dismissing the keyboard before each Continue',
    success: 'Onboarding complete',
  },
  {
    name: 'Apple Pay',
    goal: 'start the Apple Pay payment and authorize it in the sheet that appears; the sheet is not in the tree, use the screenshot',
    success: 'Payment complete: $8.99',
    platforms: ['ios'],
  },
  {
    name: 'Apple Pay Billing Address',
    goal: 'start the Apple Pay payment, fill the billing address the sheet asks for, and pay; the sheet is not in the tree, use the screenshot',
    success: 'Payment complete: $8.99',
    platforms: ['ios'],
    maxSteps: 40,
  },
];

async function complete(
  scenario: Scenario,
  { agent, device, screen }: { agent: Agent; device: Device; screen: Screen },
): Promise<void> {
  scenario.prepare?.();
  await openScenario({ device, screen }, scenario.name);
  const instruction = scenario.pixels === true
    ? `Complete this scenario as the screen instructs: ${scenario.goal}. The screen lists nothing useful; take a screenshot and work from it.`
    : `Complete this scenario as the screen instructs: ${scenario.goal}`;
  await agent.act(instruction, {
    ...(scenario.maxSteps === undefined ? {} : { maxSteps: scenario.maxSteps }),
    ...(scenario.params === undefined ? {} : { params: scenario.params() }),
  });
  if (scenario.pixels === true) {
    // The tree is merged or hidden on purpose, so the message is judged from pixels.
    await agent.assert(`the screen shows the text "${String(scenario.success)}"`, { vision: 'only' });
    return;
  }
  await expect(screen.getByTestId('success-message')).toHaveText(scenario.success);
}

for (const scenario of SCENARIOS) {
  // A gap is the skip reason; without one the scenario runs.
  test(
    `act completes ${scenario.name}`,
    {
      tags: [scenario.name],
      ...(scenario.gap === undefined ? {} : { skip: scenario.gap }),
      ...(scenario.platforms === undefined ? {} : { platforms: scenario.platforms }),
    },
    (fixtures) => complete(scenario, fixtures),
  );
}
