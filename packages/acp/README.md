# @e2e-dev/acp

Run `agent.act` and `agent.assert` on Claude Code or Codex over the
[Agent Client Protocol](https://agentclientprotocol.com). The agent signs in
with its own login, so e2e needs no model provider.

```bash
npm install -D @e2e-dev/acp @agentclientprotocol/claude-agent-acp
```

```ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { claudeCode } from '@e2e-dev/acp';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  agents: { default: { executor: claudeCode({ model: 'sonnet' }) } },
} satisfies E2EConfig;
```

- `claudeCode()` starts Claude Code through `@agentclientprotocol/claude-agent-acp`.
- `codex()` starts Codex through `@agentclientprotocol/codex-acp`.

The runner records every action, so steps replay from the cache without the
agent. See the [guide](https://e2e.tester.army/docs/subscriptions#use-your-coding-agent) for options,
containment, and limits.
