/**
 * Guideline 2.1: the app is finished. A reviewer opens every top-level
 * screen and reads what is there, then tries the app on a bad network.
 */

import { z } from 'zod';
import { GUIDELINES, audit, judge, merge, type Finding } from './audit.ts';

const MAX_SCREENS = 6;

const navigation = z.object({
  screenTitle: z.string(),
  destinations: z
    .array(z.string())
    .max(8)
    .describe('top-level destinations a user can open from here: tab bar items, menu entries, prominent cards; not the screen already showing'),
});

const FINISHED =
  'is this screen finished? Loaded content, no placeholder copy (lorem ipsum, TODO, "Label"), no broken images or empty containers, no beta, demo, or test-build wording';

audit('2.1 every top-level screen loads with finished content', ['guideline:2.1'], async (fx, conclude) => {
  const home = await fx.agent.extract('the title of this screen and its top-level navigation destinations', { schema: navigation });
  const launch = await judge(fx, GUIDELINES.completeness, 'Launch screen is finished', FINISHED);
  const screens = [launch];
  // A finding that stands in for evidence the tour could not collect.
  const unverified = (check: string, summary: string, screenshots: readonly string[] = []): Finding => ({
    ...launch,
    check,
    verdict: 'unverified',
    summary,
    evidence: [],
    screenshots,
  });
  for (const name of home.destinations.slice(0, MAX_SCREENS)) {
    await fx.agent.act(`open the "${name}" section; go back to "${home.screenTitle}" first if you are not there`);
    // The tour judges whatever is on screen, so first make sure it is the
    // named section: a wrong tap would otherwise file the home screen, or an
    // unrelated one, under this destination's name.
    const reached = await fx.agent.assert(`the "${name}" section is showing`).then(
      () => true,
      () => false,
    );
    if (!reached) {
      screens.push(
        unverified(`${name} screen is finished`, `could not confirm the "${name}" section was reached from "${home.screenTitle}"`, [
          await fx.app.screenshot(`unreached-${name}`),
        ]),
      );
      continue;
    }
    screens.push(await judge(fx, GUIDELINES.completeness, `${name} screen is finished`, FINISHED));
  }
  // Destinations past the cap were never opened; the merged verdict must not
  // read as complete coverage.
  const skipped = home.destinations.slice(MAX_SCREENS);
  if (skipped.length > 0) {
    screens.push(
      unverified(
        'Destinations beyond the audit cap',
        `${skipped.length} top-level destination(s) not opened (cap ${MAX_SCREENS}): ${skipped.join(', ')}`,
      ),
    );
  }
  conclude(merge(screens, 'Every top-level screen loads with finished content', `${screens.length} screens audited`));
});

audit('2.1 launches and explains itself with no network', ['guideline:2.1'], async (fx, conclude) => {
  try {
    await fx.device.setNetwork('offline');
    await fx.app.restart();
    await fx.agent
      .waitFor('the screen has settled: content, an offline or error message, or a blank or loading state that is no longer changing', {
        timeout: 20_000,
      })
      .catch(() => undefined);
    conclude(
      await judge(
        fx,
        GUIDELINES.completeness,
        'Handles a missing network',
        'the app was just launched with no network. Cached content or a clear offline message is compliant; a blank screen, an endless spinner, a raw technical error, or the app not running is a violation',
        { vision: 'fallback' },
      ),
    );
  } finally {
    await fx.device.setNetwork('online');
  }
});
