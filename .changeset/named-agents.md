---
"@e2edev/e2e": minor
---

Agents are named. `agents` is a record of the shapes `agent` used to take: an
options block, or the agent itself from `createAgent(...)` or any
`StepExecutor`. `default` is the agent tests run with and exists even when the
config names none (the built-in agent with `E2E_MODEL`); other names are other
brains for the same suite, and `e2e run --agent <name>` runs with one of them.
An unknown name is `INVALID_CONFIG` before anything starts, naming the
configured agents; every agent diagnostic names its entry (`agents.ux.model`);
the run-started event and the `list` reporter's run banner carry the agent's
name when it is not `default`. Breaking: the `agent` key is removed. Write
`agents: { default: <what agent held> }`; the old key is rejected with that
replacement in the message. `e2e init` scaffolds the new shape.
