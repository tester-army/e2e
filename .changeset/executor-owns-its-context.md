---
'@e2edev/e2e': minor
---

The harness is a notary, not an author: it witnesses and bounds what a step
executor does and no longer decides what the executor's model reads.

The executor context gains `attempt` (test id, attempt id, retry index, an
end-of-attempt signal, and a per-attempt `memory` map the harness holds and
never persists or reports), `step.index`, and `priorSteps` — the completed
steps as structured, sanitized records beside the existing `ledger` string.
`observe({ tree, pixels })` opts into the redacted node tree and masked
viewport pixels; pixels are withheld with a reason after a secret fill, when
masking is unproven, or when the backend has none. A `StepExecutor` may
declare `cache: 'off'` so every one of its steps reaches `runStep` instead of
a cached replay.

The agent surface is layered like the AI SDK. `createAgent` is unchanged:
the golden path, five options. `createToolLoopExecutor` is where the model's
reading is shaped: `buildPrompt` may return a message history, and it gains
`onConclude(ctx, { messages, verdict })` plus `loopGuards` / `windDown`
policy. New primitives from `@e2edev/e2e/agent` compose with the chassis or a
raw `ToolLoopAgent` and load no `ai` themselves: `createGrammarTools`,
`createVerdictTool`, `trackModelCalls`, `conversationMemory`, plus the
exported `serializeLedger`, `compactSnapshotHistory`, and
`formatReplayedPrefix`. The chassis is rebuilt on those primitives. A model
that remembers every step of a test is the chassis, the grammar tools, and
`conversationMemory`.

Spec chapter 10 now states what the ledger must guarantee (deterministic,
bounded, never model-produced, never carrying secrets) instead of prescribing
the serialization algorithm, which becomes the reference runner's exported
default.
