import { test } from "e2e";

const REMINDERS_CONTEXT = [
  "Reminders app mechanics, verified on this simulator: the accessibility",
  "tree omits the empty Title field being edited, so fill cannot target it.",
  "To add one reminder: tap the New Reminder button at the bottom left; the",
  "new row is already focused, so enter the name with the type tool, then",
  "tap the Done button in the top bar to commit. Repeat this cycle per",
  'reminder. A typed "\\n" is not a Return key and commits nothing.',
  "Tap the circle at the left of a row to complete a reminder. Swipe a row",
  "far left to delete it. Completed reminders leave the open list.",
].join(" ");

test(
  "runs a full reminders session: create, complete, delete",
  { timeout: 900_000, agentContext: REMINDERS_CONTEXT },
  async ({ agent }) => {
    await agent.act(
      'open the Reminders app, dismiss any welcome or onboarding screen, and open the default "Reminders" list; if it already contains reminders, delete them all',
    );
    await agent.act(
      'add three reminders named "Buy milk", "Walk the dog", and "Pay rent"',
    );
    await agent.assert(
      'the list shows the three open reminders "Buy milk", "Walk the dog", and "Pay rent"',
    );
    await agent.act('mark the "Buy milk" reminder as completed');
    await agent.assert(
      '"Buy milk" is no longer an open reminder, while "Walk the dog" and "Pay rent" still are',
    );
    await agent.act('delete the "Walk the dog" reminder');
    await agent.assert('"Pay rent" is the only open reminder left');
    await agent.act('delete the "Pay rent" reminder so the list ends empty');
    await agent.assert("the Reminders list has no open reminders");
  },
);
