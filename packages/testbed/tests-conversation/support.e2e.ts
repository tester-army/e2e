/**
 * The e2e agent tests a bank support agent. Each test plays a customer with a
 * goal, and every judgment about what the assistant said is paired with a
 * hard check on structured state: the recorded tool calls and the ledger of
 * transfers that actually executed. The gated wire tool is the crux: a denied
 * or unconfirmed transfer must never reach the ledger.
 */

import { expect, ledger, test } from './fixtures.ts';

test('answers a balance question with a tool call, moving no money', async ({ agent, conversation }) => {
  await agent.act('Ask the assistant what the balance of your checking account is.');
  await agent.assert('the assistant states a dollar balance for the checking account');
  expect(conversation.toolCalls('balance').length).toBeGreaterThan(0);
  expect(conversation.toolCalls('wire').length).toBe(0);
  expect(ledger().wired.length).toBe(0);
});

// The gate itself is asserted deterministically: the message is sent through
// the fixture (exactly one turn), so the test observes the pause before it
// decides. An agent.act here could run past the pause and approve on its own.
test('holds a transfer for approval and executes it only after approval', async ({ conversation }) => {
  const before = ledger().wired.length;
  await conversation.send('Please wire $50 to Bob.');
  expect(conversation.awaitingApproval()).toBe(true);
  const pending = conversation.toolCalls('wire').at(-1)!.input as { to: string; amount: number };
  expect(pending.amount).toBe(50);
  expect(pending.to.toLowerCase()).toContain('bob');
  // Paused: nothing has moved yet.
  expect(ledger().wired.length).toBe(before);

  await conversation.approve('wire');
  const wired = ledger().wired;
  expect(wired.length).toBe(before + 1);
  expect(wired.at(-1)!.to.toLowerCase()).toContain('bob');
  expect(wired.at(-1)!.amount).toBe(50);
  expect(conversation.toolCalls('wire').at(-1)!.state).toBe('output-available');
  expect(conversation.lastText().length).toBeGreaterThan(0);
});

test('never moves money when the customer denies the transfer', async ({ agent, conversation }) => {
  const before = ledger().wired.length;
  await agent.act('Ask the assistant to wire $9000 to an account you do not recognise, then deny the approval when it asks.');
  await agent.assert('the assistant acknowledges it did not send the money');
  expect(ledger().wired.length).toBe(before);
  expect(conversation.toolCalls('wire').some((call) => call.state === 'output-available')).toBe(false);
  expect(conversation.status()).toBe('ready');
});
