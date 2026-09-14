/**
 * Reminders stress suite: long agentic sessions with real data entry on a
 * real iOS app. Every agentic claim is paired with a deterministic check
 * through the accessibility tree, and every test restores the list it used.
 */

import { z } from 'zod';
import { test } from '@e2edev/agent-device';
import { expect } from 'e2e';

const REMINDERS_CONTEXT = [
  'Reminders app mechanics, verified on this simulator: the accessibility tree',
  'omits the empty title field of a reminder being edited, so the type verb',
  'cannot target it. To add one reminder: tap the New Reminder button at the',
  'bottom left; the new row is already focused, so enter the name with the',
  'type_text tool and set submit to true to commit it with Return, which also',
  'opens the next empty row; keep going for the next name. Tap Done in the top',
  'bar when the batch is complete. Tap the circle at the left of a row to',
  'complete a reminder; a completed row stays visible with a filled circle',
  'until the list is left, so judge completion by the circle. Swipe a row',
  'far left with the swipe tool to delete it: from x=350 to x=20 at the row',
  'centre y. Do not conclude blocked when the title field is invisible.',
].join(' ');

const LIST_CONTEXT = [
  'From the Reminders home screen, open a list by tapping its name. The',
  'Add List button lives at the bottom right of the home screen; a new list',
  'takes its name from the focused title field via type_text, then Done.',
  'Delete a list by swiping its row far left on the home screen and',
  'confirming.',
].join(' ');

const OPEN_DEFAULT_LIST =
  'dismiss any welcome or onboarding screen, open the default "Reminders" list, and if it already contains reminders delete every one of them';

test(
  'runs a full reminders session: create, complete, delete',
  { agentContext: REMINDERS_CONTEXT },
  async ({ agent, device }) => {
    await agent.act(OPEN_DEFAULT_LIST);
    await agent.act('add three reminders named "Buy milk", "Walk the dog", and "Pay rent"');
    for (const name of ['Buy milk', 'Walk the dog', 'Pay rent']) {
      await expect(device.locator(`text="${name}"`).first()).toBeVisible();
    }
    await agent.act('mark the "Buy milk" reminder as completed');
    await agent.assert('"Buy milk" is marked completed while "Walk the dog" and "Pay rent" are still open');
    await agent.act('delete the "Walk the dog" reminder');
    await expect(device.locator('text="Walk the dog"')).toBeHidden();
    await agent.act('delete the "Pay rent" reminder so the list ends empty');
    await expect(device.locator('text="Pay rent"')).toBeHidden();
    await agent.assert('the Reminders list has no open reminders');
  },
);

test(
  'stress: enters eight reminders in one sitting and reads them back',
  { agentContext: REMINDERS_CONTEXT },
  async ({ agent, device }) => {
    const names = ['Apples', 'Bananas', 'Coffee beans', 'Dish soap', 'Eggs', 'Flour', 'Garlic', 'Honey'];
    await agent.act(OPEN_DEFAULT_LIST);
    await agent.act(`add eight reminders, in this order and with exactly these names: ${names.map((n) => `"${n}"`).join(', ')}`);
    for (const name of names) {
      await expect(device.locator(`text="${name}"`).first()).toBeVisible();
    }
    const listed = await agent.extract('the names of every open reminder in the list, top to bottom', {
      schema: z.object({ reminders: z.array(z.string()) }),
    });
    expect(listed.reminders.map((n) => n.trim())).toEqual(names);

    await agent.act('complete every reminder whose name starts with a vowel (Apples, Eggs)');
    await agent.assert('"Apples" and "Eggs" are marked completed and the other six reminders are still open');
    await expect(device.locator('text="Bananas"').first()).toBeVisible();

    await agent.act('delete every reminder in the list, completed ones included, so the list ends empty');
    for (const name of names) {
      await expect(device.locator(`text="${name}"`)).toBeHidden();
    }
  },
);

test(
  'stress: creates a list, fills it, and deletes it again',
  { agentContext: `${REMINDERS_CONTEXT} ${LIST_CONTEXT}` },
  async ({ agent, device }) => {
    await agent.act('dismiss any onboarding screen and make sure you are on the Reminders home screen showing the lists');
    await agent.act('create a new list named "E2E Groceries" and open it');
    await expect(device.locator('role=NavigationBar id="E2E Groceries"')).toBeVisible();
    await agent.act('add two reminders named "Olive oil" and "Rice"');
    await expect(device.locator('text="Olive oil"').first()).toBeVisible();
    await expect(device.locator('text="Rice"').first()).toBeVisible();
    await agent.act('go back to the home screen and delete the "E2E Groceries" list, confirming the deletion');
    await agent.assert('no list named "E2E Groceries" is shown on the home screen');
    await expect(device.locator('text="E2E Groceries"')).toBeHidden();
  },
);

test(
  'survives an interruption: switches away mid-flow and resumes',
  { agentContext: REMINDERS_CONTEXT },
  async ({ agent, device }) => {
    await agent.act(OPEN_DEFAULT_LIST);
    await agent.act('add one reminder named "Call the bank"');
    await expect(device.locator('text="Call the bank"').first()).toBeVisible();

    await device.home();
    await device.openApp('Settings');
    expect((await device.foregroundApp()).name).toBe('Settings');
    await device.openApp('Reminders');

    await agent.assert('the "Call the bank" reminder is still shown as open');
    await agent.act('delete the "Call the bank" reminder so the list ends empty');
    await expect(device.locator('text="Call the bank"')).toBeHidden();
  },
);
