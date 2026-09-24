---
'e2e': minor
---

The agent gets a tool for each action its engine declares beyond tap and type: `hover` and `hover_at`, `double_tap`, `long_press`, `right_click`, `check`, `drag`, `scroll_to`, `upload`, and `back`. Each is offered only when the engine declares the action, records into the trace cache with the node it acted on, and replays zero-turn. `upload` takes project-relative paths and refuses, before the engine sees them, a file outside the project root or one that is hidden or under a hidden directory, as `POLICY_DENIED`. The new tool names are reserved: a project tool named like one is refused at `createAgent`, as `tap` and `scroll` already were.
