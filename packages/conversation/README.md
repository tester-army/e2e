# @e2edev/conversation

The conversation backend for [`e2e`](https://www.npmjs.com/package/@e2edev/e2e):
test an AI agent by talking to it. The e2e agent plays the user, the agent
under test replies, and the same `screen`, `expect`, `app`, and `agent` a
browser test uses work unchanged. Built for agents written with the
[AI SDK](https://ai-sdk.dev) (v7).

## Install

```bash
npm install --save-dev @e2edev/e2e @e2edev/conversation ai
```

```ts title="e2e.config.ts"
import { defineConfig } from '@e2edev/e2e';
import { createAgent } from '@e2edev/e2e/agent';
import { conversation } from '@e2edev/conversation';
import { conversationTools } from '@e2edev/conversation/tools';
import { myAgent } from './src/agent.ts'; // your AI SDK agent

const chat = conversation({ agent: myAgent });

export default defineConfig({
  targets: [{ name: 'assistant', platform: 'conversation', backend: chat }],
  workers: 1,
  agent: { executor: createAgent({ tools: conversationTools(chat) }) },
});
```

```ts
import { test } from '@e2edev/conversation';
import { expect } from '@e2edev/e2e';

test('refunds only after the customer confirms', async ({ conversation }) => {
  await conversation.send('I want a refund on order 4411');
  expect(conversation.awaitingApproval()).toBe(true);   // the refund tool is gated
  await conversation.approve('issueRefund');
  expect(conversation.toolCalls('issueRefund').at(-1)!.state).toBe('output-available');
});
```

## Attaching the agent under test

Name exactly one of:

| Option | The agent under test is |
| --- | --- |
| `agent` | An AI SDK v7 agent object (`new Experimental_Agent({...})`), run in this process through the SDK's `DirectChatTransport`. No server. |
| `api` | A deployed chat endpoint that speaks the AI SDK UI message stream protocol (a Next.js `/api/chat` route), driven with `DefaultChatTransport`, so the test exercises what is shipped. |
| `transport` | A ready-made AI SDK `ChatTransport`, for anything the two above cannot express. |

Other options: `name` (label for reports and the trace anchor), `history` (a
prior transcript to start mid-conversation; user and assistant messages only,
because an agent owns its own system prompt), and `headers` (for the `api`
transport).

## What the backend declares

- **Observation** is the transcript. One `application` root named after the
  agent; one node per message (role `user`, `assistant`, or `system`) whose
  children are its text and tool parts; each tool call a `status` node named
  `tool <name>` carrying its state and input or output; the composer a focused
  `textbox`. When the assistant pauses on a tool that needs approval, the
  paused tool gets `Approve` and `Deny` `button` children and the composer is
  withheld, so the next move is a decision.
- **Actions**: `fill` the composer and `press` Enter to send a message; `tap`
  Approve or Deny to answer a gated tool. `focus` is a no-op. Everything else
  is `UNSUPPORTED_CAPABILITY`. So the default agent grammar drives a
  conversation with no custom tools.
- **Location**: `getByText` and `getByRole` (`textbox`, `button`, `status`,
  and the message roles) over the transcript, filters, `first`/`last`.
- **App**: `restart()` starts a fresh conversation from the seeded history.
- **`url`**: `app://conversation/<agent>/<status>`, the trace cache's anchor.

## The `conversation` fixture

Deterministic control and structured access, recorded as
`conversation.<method>` steps. This is how a test drives the exact turns it
wants and asserts on what the agent did, not only what it said.

| Member | Meaning |
| --- | --- |
| `send(text)` | Send a user message; resolves when the turn finishes or pauses on an approval. |
| `approve(tool?, { reason? })` | Approve the pending gated tool (by name when several) and resume. |
| `deny(tool?, { reason? })` | Deny it and resume. |
| `toolCalls(name?)` | Every tool call, with `state`, `input`, `output`, and `approved`. |
| `messages()` | The whole transcript. |
| `lastText()` | The newest assistant message's text. |
| `status()` | `ready`, `awaiting-approval`, or `error`. |
| `awaitingApproval()` | Whether a gated tool is waiting. |

Assert on side effects, not prose: check `toolCalls('issueRefund')` and your
own database or ledger, and let the wording vary. Pair each judgment
(`agent.assert`) with one such hard check.

## Agent tools

`@e2edev/conversation/tools` exports `conversationTools(...backends)`:
`send_message` (say something as the user and read the reply) and
`respond_to_approval` (approve or deny the pending tool). They are sugar over
the grammar, scoped to the `conversation` platform. Drive the gate itself
through the fixture, though: an `agent.act` step is free to run past a pause
and decide on its own, where `conversation.send` stops exactly at the pause.

## Secrets

A conversation has no field to fill and no origin to check, so `type_secret`
is denied on a conversation target. Give the agent its credentials through its
own configuration.

## Documentation

Full documentation lives at
[e2e.docs.buildwithfern.com](https://e2e.docs.buildwithfern.com/reference/conversation).
