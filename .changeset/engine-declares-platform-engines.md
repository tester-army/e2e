---
"@e2edev/playwright": minor
"@e2edev/agent-device": minor
---

Both engines declare their platform on the handle: `web` for playwright, the
`platform` option for agent-device. A target that names them no longer has to
repeat it. Both engines now require `@e2edev/e2e` 0.8 or newer (peer range
`>=0.8.0 <1`): an older runner rejects `platform` as an unknown engine key,
and could still send `states.hidden` in a role query, which these engines no
longer read.
