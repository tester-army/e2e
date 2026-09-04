---
'@e2edev/conversation': minor
---

New package: `@e2edev/conversation`, a backend that tests an AI agent by
talking to it. The e2e agent plays the user; the agent under test replies;
`screen`, `expect`, `app`, and `agent` work unchanged. Built for
[AI SDK](https://ai-sdk.dev) v7 agents.

- `conversation({ agent })` runs an in-process AI SDK agent through the SDK's
  `DirectChatTransport`; `conversation({ api })` drives a deployed
  `/api/chat` route through `DefaultChatTransport`; `conversation({ transport })`
  takes a ready-made `ChatTransport`.
- Observation is the transcript: a node per message, a `status` node per tool
  call carrying its state and input or output, a focused composer `textbox`,
  and `Approve`/`Deny` buttons when the assistant pauses on a gated tool. The
  default grammar drives it: `fill`+`press Enter` sends, `tap` answers an
  approval.
- The `conversation` fixture gives deterministic control and structured
  oracles: `send`, `approve`, `deny`, `toolCalls`, `messages`, `lastText`,
  `status`, `awaitingApproval`. Assert on tool calls and side effects, not
  wording.
- `@e2edev/conversation/tools` exports `conversationTools(...backends)`:
  `send_message` and `respond_to_approval`, scoped to the `conversation`
  platform.
- `app.restart()` starts a fresh conversation; `url` mints
  `app://conversation/<agent>/<status>` for the trace cache. Tool approvals
  (`needsApproval`) pause the turn and resume on the answer, so a test can
  prove a gated action never runs until approved.
