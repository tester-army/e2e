---
"e2e": patch
---

The replay cache no longer passes a step whose effect did not happen. Entries are keyed by the agent and a hash of its redacted context, so one persona never replays another's steps and a changed `agentContext` records again. A route now includes the origin and the query (ids, tokens, and timestamps aside), and the end route must match exactly. A replay checks what the step made appear, with checked or selected state, and what it made disappear, needs at least one of those changes to happen during the replay, and stops on an alert the recording never saw. A count the step made appear is part of the effect, and an unnamed control with twins needs a named row or group to replay. Every existing entry is re-recorded on the first run after the upgrade.
