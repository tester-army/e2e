---
"@e2edev/e2e": patch
---

`act` observations are now clamped the way judgment observations already
were: the tree an act turn sends is bounded by the per-call token ceiling
minus what the rest of the request costs, so a dense screen truncates
visibly instead of failing the adapter's pre-flight. The default
`agent.maxObservationBytes` drops from 1048576 to 262144; set it explicitly
to keep the old ceiling. The act loop also retries transport failures five
times and bounds the whole loop by the step's remaining time, like the
judgment calls, and `STEP_NO_CONCLUSION` reports how many turns the model
used rather than the configured maximum.
