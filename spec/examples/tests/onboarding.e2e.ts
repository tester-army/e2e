import { test } from '@e2edev/e2e';
import { z } from 'zod';

/**
 * A genuinely sequential wizard: serial group — ordered, one worker, shared
 * app state; a failure skips the rest. Also shows cross-step data flow:
 * values move through code (extract → variable → params), while situational
 * awareness ("step 1 already happened") flows through the step ledger
 * automatically.
 */
test.describe('workspace onboarding wizard', {
  serial: true,
  session: 'member',
  agentContext: 'The onboarding wizard appears once per new workspace.',
}, () => {
  let inviteLink: string;

  test('step 1: create the workspace', async ({ app, agent }) => {
    await app.open('/onboarding');
    await agent.act('create a workspace named "Rocketry" in the Engineering category');
    await agent.assert('the wizard advanced to the team step');
  });

  test('step 2: generate an invite link', async ({ agent }) => {
    await agent.act('generate a shareable invite link for teammates');

    const data = await agent.extract('the invite link shown in the dialog', {
      schema: z.object({ inviteLink: z.string().url() }),
    });
    inviteLink = data.inviteLink;
  });

  test('step 3: invite link works in a fresh session', async ({ app, agent }) => {
    await app.clearState();               // factory-fresh: restart() would keep storage
    await app.deepLink(inviteLink);

    await agent.assert('the join screen shows the "Rocketry" workspace');
  });
});
