/**
 * `agent.act()` against the task scenarios whose semantics survive in the
 * accessibility tree. Each step gets the catalog description as its goal and
 * reads the rest off the page; the deterministic check on the scenario's
 * success message decides the test. Scenarios that need pixels (canvas, image
 * and CSS-content UIs, the aria-hidden flow, the onboarding wizard), native
 * dialogs, a second tab, or a file the agent first downloads are left out:
 * the grammar has no verb for them yet.
 */

import { test } from '@e2edev/web';
import { expect } from 'e2e';
import type { Agent, App, Screen } from 'e2e';

interface Scenario {
  readonly slug: string;
  readonly goal: string;
  readonly success: string;
  /**
   * Why the grammar cannot finish this scenario yet. The test is declared and
   * skipped with the reason, so the gap stays visible in every run and the
   * scenario turns on the day the verb lands.
   */
  readonly gap?: string;
  /** A step budget above the default, for a flow that legitimately needs more actions. */
  readonly maxSteps?: number;
}

const SCENARIOS: readonly Scenario[] = [
  {
    slug: 'shadow-dom-form',
    goal: 'fill the form buried in the nested shadow roots and submit it to get access',
    success: 'Access granted',
  },
  {
    slug: 'lying-labels',
    goal: 'send the payment; the visible text on the controls is the truth, the accessible names are not',
    success: 'Payment sent',
  },
  {
    slug: 'iframe-form',
    goal: 'read the coupon code shown in one frame and apply it through the form in the other frame',
    success: 'Coupon applied',
  },
  {
    slug: 'infinite-scroll',
    goal: 'scroll the feed until the Golden Ticket loads, then claim it',
    success: 'Golden Ticket claimed',
    // Item 138 of 200 arrives after seven lazy loads; that is about thirty
    // scrolls, more than the default action budget of 25.
    maxSteps: 60,
  },
  {
    slug: 'virtualized-table',
    goal: 'scroll the windowed table until the Golden Row (row 4322) is rendered, then claim it',
    success: 'Golden Row claimed',
  },
  {
    slug: 'overlay-trap',
    goal: 'dismiss the cookie banner and the overlay in the way, then press Continue',
    success: 'You made it past the overlay',
  },
  {
    slug: 'sticky-chrome',
    goal: 'scroll down to the accept button and accept the terms',
    success: 'Terms accepted',
  },
  {
    slug: 'async-states',
    goal: 'wait for the page to finish loading, read the verification code it shows, enter it, and submit once the button enables',
    success: 'Code verified successfully',
  },
  {
    slug: 'debounced-search',
    goal: 'search for trail mix and add exactly the item the page asks for to the cart',
    success: 'Added Trail Mix 500 g to the cart',
  },
  {
    slug: 'hover-menu',
    goal: 'find Redeem voucher under the Account menu and redeem the voucher',
    success: 'Voucher redeemed',
  },
  {
    slug: 'drag-and-drop',
    goal: 'drag the right items into the dropzone in the order the page asks for',
    success: 'Items dropped in the right order',
  },
  {
    slug: 'kanban-board',
    goal: 'move the cards so the board matches the goal layout the page describes, then submit the board',
    success: 'Board matches the goal',
  },
  {
    slug: 'context-menu-trap',
    goal: 'rename the file report.pdf to summary.pdf in the file manager',
    success: 'File renamed to summary.pdf',
  },
  {
    slug: 'stale-dom',
    goal: 'click the Tap me button three times; the list rebuilds itself every second',
    success: 'Target clicked 3 times',
  },
  {
    slug: 'otp-auto-advance',
    goal: 'enter the 6-digit code the page shows into the segmented code inputs and verify it',
    success: 'Code verified',
  },
  {
    slug: 'date-picker',
    goal: 'book an appointment for the exact date the page requires, navigating the calendar to it',
    success: 'Appointment booked for September 17, 2026',
  },
  {
    slug: 'rich-text-editor',
    goal: 'type "release approved" into the editor, make exactly the word approved bold, and check the document',
    success: 'Document approved',
    gap: 'selecting text inside a contenteditable needs a selection verb; press moves the caret one key at a time',
  },
  {
    slug: 'playbook-cleanup',
    goal: 'delete the playbook named "Launch Approval Draft", confirm the removal, then search for its exact name to verify it is gone',
    success: 'No playbooks match "Launch Approval Draft".',
  },
  {
    slug: 'promo-storefront',
    goal: 'buy any one product, dismissing the promotional overlays that get in the way, until the order is confirmed',
    success: 'Order confirmed',
  },
  {
    slug: 'gift-card-purchase',
    goal: 'buy a gift card for friend@example.com and complete the purchase',
    success: 'Gift card sent to friend@example.com',
  },
];

async function complete(
  scenario: Scenario,
  { app, agent, screen }: { app: App; agent: Agent; screen: Screen },
): Promise<void> {
  await app.open(`/e/${scenario.slug}`);
  await agent.act(
    `Complete this scenario as the page instructs: ${scenario.goal}`,
    scenario.maxSteps === undefined ? undefined : { maxSteps: scenario.maxSteps },
  );
  await expect(screen.getByTestId('success-message')).toHaveText(scenario.success);
}

for (const scenario of SCENARIOS) {
  const title = `act completes ${scenario.slug}`;
  if (scenario.gap === undefined) {
    test(title, { tags: [scenario.slug] }, (fixtures) => complete(scenario, fixtures));
  } else {
    test.skip(title, (fixtures) => complete(scenario, fixtures));
  }
}

test('act filters the list and the URL carries the filter', async ({ app, agent, web }) => {
  await app.open('/e/filter-deep-link');
  await agent.act('filter the product list down to the mug');
  await expect(web).toHaveURL('/e/filter-deep-link?q=mug');
});
