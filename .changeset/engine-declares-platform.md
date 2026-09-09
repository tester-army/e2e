---
"@e2edev/e2e": minor
---

An engine declares the platform it drives, and a target inherits it.
`Target.platform` is optional: with the name already defaulting to the
platform, `{ engine: playwright({ url }) }` is a complete target, and so is
`{ engine: agentDevice({ platform: 'ios', app }) }`. A target without an engine
still names its platform. A target that names one while its engine declares
another is `INVALID_CONFIG` instead of a label the tool packs silently disagree
with. `Engine.platform` joins the engine contract as an optional member, and
`e2e init` scaffolds targets without the redundant label.
