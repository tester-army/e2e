---
'e2e': minor
---

Implement `agent.act`, the planning tier.

`agent.act(instruction, params?, options?)` plans and executes a bounded
multi-action flow. One call is one invocation that repeats a single cycle —
observe, ask for the next action, authorize it, commit it — until the model
concludes. The model answers with one `agent-tool-1` object per round and never
reaches the driver: the runner validates every proposal against the action space
and the security policy, then dispatches itself.

- Action vocabulary: tap, plain and sensitive type, scroll, press, long-press,
  origin-authorized navigate, observe, conclude.
- A `Secret` in `params` is disclosed to the model as its name and purpose only;
  the value is resolved host-side immediately before an authorized fill.
- The schema overload validates `conclude.data` with Standard Schema v1 and
  re-prompts for repair while budget remains.
- Budgets are runner-owned: `STEP_BUDGET_EXHAUSTED` on exhaustion,
  `STEP_TIMEOUT` on the deadline, `STEP_NO_CONCLUSION` when one action repeats
  against an unchanged screen. Exhaustion is never reported as success.
- A failed action is fed back to the next round so the model can route around it,
  up to three consecutive failures.

Path guidance (`cache-1` `path` entries) records the actions a successful flow
took and offers them to the next run as the route that worked. It is advisory:
the model still observes and decides every round, so it reduces wrong turns
rather than model calls. Diverging before any mutating action commits discards
the guidance; diverging after one rejects with `CACHE_REPLAY_DIVERGED` rather
than re-running a half-applied flow.

`agent.login` still rejects with `UNSUPPORTED_CAPABILITY`; pass the credential to
`agent.act` as a parameter instead.

Retry a provider that returns no structured output. `result.output` is an AI SDK
getter that throws `NoOutputGeneratedError` — a different class from a response
that parsed and failed validation — so an empty response was classified as
`MODEL_PROVIDER_FAILED` (infrastructure, exit 3) and failed the run immediately.
It is now invalid output, which the existing bounded repair loop re-asks, and the
retry re-sends the request unchanged rather than quoting a response that never
existed. Exhausting the budget still fails with `MODEL_OUTPUT_INVALID`.

`--debug` now streams the agent's decisions to stderr as they happen — one line
per planning round with the action taken and its outcome — instead of only
printing phase timings after the run. It is equivalent to `E2E_DEBUG=agent` and
propagates to worker processes. A `STEP_TIMEOUT` or `STEP_BUDGET_EXHAUSTED` from
`agent.act` additionally reports which round it stopped in and what it had
already done, because the operation that happened to be running when the clock
expired says nothing about whether the flow was progressing.

Fix a planning stall on providers that fill in every declared schema property.
The `agent-tool-1` request schema is one flat object carrying every kind's
arguments, because strict structured-output modes reject a root union — so a model
answering `conclude` would often attach a stray `value` or `key` beside it. The
validator treated that as invalid output, and since the repair round could only
produce the same response, a flow that had already decided correctly burned its
entire model-call budget. Fields the chosen kind does not take are now ignored.
Selection stays strict: it picks the entry whose required arguments are all
present, so a spurious `purpose` cannot turn a plain fill into a secret fill, and
a genuinely ambiguous `type` is still refused. A repair loop that produces the
identical rejection twice is also abandoned rather than re-asked until the budget
runs out.

Never fail a flow for declining path guidance. `CACHE_REPLAY_DIVERGED` was raised
when the model chose differently after a mutating action had committed, which made
the cache turn passing tests red on any page whose content moves between runs —
the one thing a cache must not do. The spec clause it came from governs blind
replay, where a broken replay can leave a flow half-applied and restarting would
re-apply it; nothing here ever replays, since every action is a fresh decision
against a fresh observation, so the hazard cannot arise. Declining a suggestion
now simply discards it. `CACHE_REPLAY_DIVERGED` is consequently unreachable.

Wind down instead of cutting off. An invocation with no action steps left is now
offered only `observe` and `conclude`, and every round is told what budget
remains, so a flow that runs out reports what it found instead of surfacing a bare
`STEP_BUDGET_EXHAUSTED`. Repeating one action against an unchanged screen no
longer fails on the first repeat either: the action is not dispatched — repeating
a submit or a purchase is not safe to do on the caller's behalf — and the model is
told the screen did not move so it can observe, reroute, or conclude.
`STEP_NO_CONCLUSION` now needs a second repeat.

Question a premature failure once. An `agent.act` that concluded `failure` while it
still had budget was accepted immediately, so a flow would give up on a disabled
button without looking for the empty required field that disabled it. The runner
now challenges the first such conclusion, naming what to look for — an unfilled
field, an unticked consent, a dialog in the way, a control that enables once
something else is set — and accepts the second one as the result. Bounded to a
single challenge, so a genuine dead end costs one extra round rather than the
remaining budget. The prompt carries the same rule, so concluding `failure` is
expected to follow an attempt at recovery rather than precede one.

`--debug`'s cache table no longer credits path guidance with model time it never
saved: `StepCacheInfo` records the entry kind, only locate hits count toward the
estimate, and path hits are reported as "N guided by a recorded path".

Recover from a node the page replaced mid-dispatch. A driver failure flagged
retryable — Playwright's "Element is not attached to the DOM" — proves nothing was
performed, so it no longer costs an action step, no longer counts toward the
consecutive-failure limit, and no longer tells the model to try a different route
when its choice was right. The next round reads the new document and asks again,
bounded to three such retries. Detection walks the cause chain, because the
driver's error is wrapped onto the closed agent code set before the loop sees it.

Make `--debug` readable. Per-phase timings moved behind `E2E_DEBUG=phases`, so
decisions are no longer buried under seven lines of observation, model, and driver
timing per round. Each planning step now prints one line carrying the action-step
budget it is spending:

```
[e2e agent] agent.act "complete the onboarding for Acme" - up to 8 action(s), 25 call(s), 60s
[e2e agent] 1/8 tapped the button "Get started" - ok 22ms
[e2e agent] 2/8 typed "Acme" into the node "Company name" - ok 4ms
[e2e agent] 2/8 tapped a combobox - page moved, re-reading
[e2e agent] 5/8 done success - the summary confirms Acme
[e2e agent] agent.act end - 5 action(s), 6 call(s), 720 tokens, $0.0186
```
