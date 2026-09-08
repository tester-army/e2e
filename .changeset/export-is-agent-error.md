---
"@e2edev/e2e": minor
---

`isAgentError` is exported from `@e2edev/e2e`, next to `AgentError`. Test
files load in their own module realm, so `instanceof AgentError` can be false
for an error the runner threw; `isAgentError` checks a cross-realm marker and
narrows to `AgentError`, so a test can branch on `error.code` without
importing `@e2edev/e2e/agent`.
