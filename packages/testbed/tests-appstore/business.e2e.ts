/**
 * Guidelines 3 (Business), 1.2 (User-Generated Content), and 4 (Design):
 * how the app sells, how it moderates, and whether it is a real app. The
 * design checks are advisory and never fail the run.
 */

import { GUIDELINES, audit, judge, launched, reach } from './audit.ts';

audit(
  '3.1.1 and 3.1.2: digital goods use in-app purchase and subscriptions disclose their terms',
  ['guideline:3.1.1', 'guideline:3.1.2'],
  async (fx, conclude) => {
    const note = await reach(
      fx,
      'find where the app sells anything: Upgrade, Premium, Pro, Plus, Subscribe, Store, Shop, coins, credits, or a paywall; open it and stop before any purchase sheet appears; if nothing is for sale, stop where you are',
    );
    conclude(
      await judge(
        fx,
        GUIDELINES.payments,
        'Digital goods sold through in-app purchase, no steering',
        'what does this screen sell and how is it paid for? not-applicable when nothing is sold; compliant for physical goods or services, or for digital goods bought through the App Store payment sheet; unverified when digital goods are sold but the mechanism cannot be told; violation when digital goods are paid through an external link or an in-app card form, or copy steers users to buy elsewhere',
        { note },
      ),
      await judge(
        fx,
        GUIDELINES.subscriptions,
        'Subscription paywall discloses its terms',
        'if a subscription is offered, does the paywall show the price, the billing period, that it renews automatically until cancelled, and links to Terms of Use and Privacy Policy? not-applicable when no subscription is offered; list what is missing as evidence',
        { note },
      ),
    );
  },
);

audit('1.2 user-generated content can be reported and its authors blocked', ['guideline:1.2'], async (fx, conclude) => {
  const note = await reach(
    fx,
    'find content posted by other users: a feed, comments, reviews, chat, or community section; open one post or another user\'s profile and reveal its actions (the "..." or more button, a long press, or the share menu) and stop; if the app shows nothing posted by other users, stop where you are',
  );
  conclude(
    await judge(
      fx,
      GUIDELINES.ugc,
      'Report and block controls on user-generated content',
      'does this screen show content posted by other users, and are report and block actions available for it? not-applicable when the app shows nothing posted by other users; violation when either action is missing',
      { note },
    ),
  );
});

audit('4.2 is a real app, not a wrapped website or static brochure', ['guideline:4.2'], async (fx, conclude) => {
  const note = await reach(
    fx,
    'get to the main screen of the app: past any splash, welcome, or onboarding, and interact with one thing there (open an item, switch a tab) so the screen shows real content; stop there',
  );
  conclude(
    await judge(
      fx,
      GUIDELINES.minimumFunctionality,
      'Native app with interactive functionality',
      'is this a real app, or a website in a full-screen web view, or a static brochure with nothing to do? violation for a web wrapper or static content only',
      { vision: true, note },
    ),
  );
});

audit('4.0 stays legible in dark mode', ['guideline:4.0'], async (fx, conclude) => {
  try {
    await fx.device.setAppearance('dark');
    await fx.app.restart();
    await launched(fx);
    conclude(
      await judge(
        fx,
        GUIDELINES.design,
        'Legible in dark mode',
        'with the system in dark mode, is all text legible and nothing clipped or overlapping? staying light is compliant; low-contrast text, or text cut off inside its own container, is a violation; a horizontally scrolling row (tabs, chips) whose last item runs past the screen edge is not clipping',
        { vision: true },
      ),
    );
  } finally {
    // The setup relaunched to apply dark mode at launch; the teardown
    // relaunches the same way so the next check starts light for real.
    await fx.device.setAppearance('light');
    await fx.app.restart();
  }
});
