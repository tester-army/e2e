# @e2e-dev/acp

Run `agent.act` and `agent.assert` on a coding agent you already use, over
the [Agent Client Protocol](https://agentclientprotocol.com): Claude Code,
Codex, or any agent with an ACP mode. The agent signs in with its own login,
so e2e needs no model provider of its own.

```bash
npm install -D @e2e-dev/acp @agentclientprotocol/claude-agent-acp
```

```ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { acpExecutor } from '@e2e-dev/acp';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  agents: {
    default: { executor: acpExecutor.claudeCode({ model: 'sonnet' }) },
  },
} satisfies E2EConfig;
```

`acpExecutor.codex()` starts Codex once `@agentclientprotocol/codex-acp` is
installed beside it. `acpExecutor({ command, args })` starts another ACP
agent; its calls of the step tools are allowed only when its adapter names
them the way the Claude Code and Codex adapters do, and fail the step
otherwise.

One agent session serves one test attempt. The agent gets the built-in
agent's action tools for the verbs the target's engine supports, and
`complete_step`. Each preset turns off the agent's own tools, and a tool of
its own that runs anyway fails the step. Every action goes through the
runner, so steps replay from the cache without the agent.

See the [guide](https://e2e.tester.army/docs/acp) for options and limits.
