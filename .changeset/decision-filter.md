---
"@e2e-dev/decision": minor
---

**Release:** Add `decisionFilter({ model })`, a test filter that asks a decision model which tests a pull request can affect and leaves out the rest, such as `filters: [decisionFilter({ model: gateway.decisionModel('typesafe-ai/jev') })]`. The model must answer `boolean` questions; `providerOptions` passes options such as zero data retention to every call. Needs `e2e` 0.21.3 or later.
