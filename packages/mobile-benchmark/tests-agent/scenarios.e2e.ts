/**
 * `agent.act()` against every scenario, one step each: the step gets the
 * catalog description as its goal and reads the rest off the screen; the
 * deterministic check on the scenario's success message decides the test.
 * Scenarios the harness cannot finish yet are declared and skipped with the
 * reason, so the gap stays visible in every run.
 */

import type { Device } from '@e2edev/agent-device';
import type { Agent, Screen } from 'e2e';
import { expect, openScenario, test } from '../tests/fixtures.ts';

interface Scenario {
  /** The home-list row, which is also the scenario's screen title. */
  readonly name: string;
  readonly goal: string;
  readonly success: string;
  /**
   * Why the harness cannot finish this scenario yet. The test is declared and
   * skipped with the reason, and turns on the day the capability lands.
   */
  readonly gap?: string;
  /** The platforms whose fixture the scenario depends on; both by default. */
  readonly platforms?: readonly ('ios' | 'android')[];
  /** A step budget above the default, for a flow that legitimately needs more actions. */
  readonly maxSteps?: number;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'Login Form',
    goal: 'log in with the account the screen shows as a hint',
    success: 'Logged in successfully',
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
    goal: 'complete the flow the screen describes',
    success: '',
    gap: 'the whole screen is one accessibility node and success is visible only in pixels',
  },
  {
    name: 'Vision Only',
    goal: 'complete the flow the screen describes',
    success: '',
    gap: 'the accessibility tree is hidden and success is visible only in pixels',
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
    goal: 'scroll to Row 0512 and tap it; the list has 600 rows and off-screen rows are not in the tree',
    success: 'Found Row 0512',
    gap: 'the target is dozens of screens down and scroll moves one screen at a time',
  },
  {
    name: 'Flattened Registration Form',
    goal: 'fill the registration form and sign up',
    success: '',
    gap: 'the form is one accessibility node and success is visible only in pixels',
  },
  {
    name: 'Flattened Login',
    goal: 'log in with the benchmark account',
    success: '',
    gap: 'the form is one accessibility node and success is visible only in pixels',
  },
  {
    name: 'Sticky Chrome Target',
    goal: 'scroll down to the Accept button under the sticky footer and accept the terms',
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
    goal: 'attach the receipt photo from the photo library',
    success: '',
    gap: 'the receipt photo must be seeded into the device library first, and the picker lives outside the app tree',
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
    gap: 'the sheet talks to Stripe’s demo backend over the network and its fields move under the keyboard',
  },
  {
    name: 'Sequential Onboarding',
    goal: 'complete the signup wizard with the email, name, and phone the screen asks for, dismissing the keyboard before each Continue',
    success: 'Onboarding complete',
  },
  {
    name: 'Apple Pay',
    goal: 'start the Apple Pay payment and authorize it in the sheet',
    success: 'Payment complete: $8.99',
    platforms: ['ios'],
    gap: 'the PassKit sheet renders out of process and never enters the app tree',
  },
  {
    name: 'Apple Pay Billing Address',
    goal: 'start the Apple Pay payment, fill the billing address in the sheet, and pay',
    success: 'Payment complete: $8.99',
    platforms: ['ios'],
    gap: 'the PassKit sheet renders out of process and never enters the app tree',
  },
];

async function complete(
  scenario: Scenario,
  { agent, device, screen }: { agent: Agent; device: Device; screen: Screen },
): Promise<void> {
  await openScenario({ device, screen }, scenario.name);
  await agent.act(
    `Complete this scenario as the screen instructs: ${scenario.goal}`,
    scenario.maxSteps === undefined ? undefined : { maxSteps: scenario.maxSteps },
  );
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
