---
"e2e": patch
---

Pin an `agent.act()` step to its recording. `e2e run --pin` writes the recording of each selected step not pinned yet to `<test>.steps.json` beside the test, and `agent.act(goal, { steps: [] })` makes the next local run write the step's actions into the call. Either way, a step pins only when its test passes and a later check confirms it. A pinned step replays with the replay cache off or fails with `REPLAY_STALE`; it never calls the model, and a recording made under another engine, engine contract, replay policy, app identity, or agent context fails too, naming the field. `--pin all` records the steps again.
