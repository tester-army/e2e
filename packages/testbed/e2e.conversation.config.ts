/**
 * Opt-in conversation suite on the `@e2edev/conversation` backend: the e2e
 * agent tests another agent. The app under test is a small AI SDK support
 * agent (`fixtures/support-agent.ts`) with a money-transfer tool gated on
 * approval; the backend runs it in this process, so no server and no second
 * transport are involved. Run manually:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2edev/testbed test:conversation
 *
 * `AI_GATEWAY_API_KEY` powers both the agent under test and the e2e agent
 * (they can be different models: `E2E_SUPPORT_MODEL` picks the one under
 * test, `E2E_MODEL` the tester). Not part of CI: every step spends real
 * model calls on both sides.
 */

import { defineConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { conversation } from '@e2edev/conversation';
import { conversationTools } from '@e2edev/conversation/tools';
import { createGateway } from 'ai';
import { createSupportAgent } from './fixtures/support-agent.ts';

// One agent instance per config load; its ledger (read by the suite through
// currentLedger) is the side-effect oracle the tests assert on.
const support = createSupportAgent();

const bank = conversation({ agent: support.agent, name: 'bank-support' });

export default defineConfig({
  specVersion: '0.1',
  projectId: 'dev.e2e.testbed-conversation',
  tests: 'tests-conversation/**/*.e2e.ts',
  targets: [{ name: 'bank-support', platform: 'conversation', backend: bank }],
  timeout: 300_000,
  actionTimeout: 90_000,
  workers: 1,
  agent: {
    executor: createAgent({ tools: conversationTools(bank) }),
    model: createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY ?? '' }).languageModel(
      process.env.E2E_MODEL ?? 'openai/gpt-5.6-luna',
    ),
    maxModelCalls: 40,
    context: [
      'The surface is a chat with an AI assistant under test: the bank support',
      'assistant. You are the customer. Send a message with send_message and',
      'read the assistant\'s reply. When the assistant tries to move money it',
      'pauses for approval: respond_to_approval with approved true or false',
      'resumes it. Play the role the test describes; judge the assistant by',
      'what it says and does, and do not do its job for it.',
    ].join(' '),
  },
});
