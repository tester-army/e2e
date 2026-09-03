---
'e2e': minor
---

The runner ships no agent, and the harness under any agent got a great deal
more reliable.

Breaking: `createAgent` is gone from `e2e/agent`. The `agent` config value
takes the executor itself, or `agent.executor` beside the options; a config
that names none still runs deterministic tests and the judgment tier
(`assert`, `waitFor`, `extract`), and its first `agent.act()` fails with
`INVALID_CONFIG` naming the missing executor. `createToolLoopExecutor` is the
chassis to build one on; `isDefinedTool`, `toolAppliesTo`, and
`RUNTIME_CODES` are exported for executors that merge project tools into
their own vocabulary.

Chassis (`createToolLoopExecutor`):

- `prepareMessages(messages, turn)` replaces `compactMessages`: the returned
  history carries forward to later turns, and `{ messages, stop }` requests a
  forced conclusion when the executor has evidence the loop guards cannot see.
- A `complete_step` issued alongside other tool calls is discarded and the
  model is told to look at the results first.
- Model calls sample at temperature 0; `providerOptions` are passed through.
- `StepVerdict.facts`: values a later step may need, verbatim.

Observations and hand-off:

- `ExecutorObservation.path` carries the current location; observations expose
  `parents` for container lookups.
- Observations list a combobox's options as child nodes and no longer repeat a
  container's name when it only echoes its children.
- The step ledger hands over `did:` (recorded actions), `saw:` (text that
  appeared or changed on screen during the step), `noted:` (the executor's
  facts) and `observed:` (its summary); a replayed step hands over only what
  it did and showed on this run. Under its byte budget the ledger compacts by
  value: the newest steps in full, then checks, fact-less steps, and finally
  fact-bearing steps are dropped, middle first, with the gaps marked.
- Judgment-tier observations (`assert`, `extract`) settle exactly like
  executor observations.

Trace cache:

- A typed value found neither in the instruction nor in the params is recorded
  as a gap: replay hands over before it instead of typing a run-time value.
- A trace records the text that appeared over the step and the recorded run's
  duration; replay is complete only once that text is on screen again, waited
  for up to that duration, and hands off when it never returns.
- Targeted actions record the key of the row or list item they sat in, and
  relocation requires it, so same-named controls in different rows replay
  zero-turn. Replay policy `conservative/3`.

Model plumbing: gateway models carry a stall guard (a generate with no answer
in 120 s is abandoned and re-issued, three attempts).
