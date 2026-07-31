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
rather than model calls, and declining it discards the remaining guidance rather
than failing the flow. A recorded fill names its target and not the value it
typed.

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

`spec/10-determinism.md` now states that guidance is advisory and MUST NOT be
able to turn a passing invocation into a failing one, and scopes
`CACHE_REPLAY_DIVERGED` to a runner that dispatches recorded actions without
re-deciding. The previous wording required the code whenever the model chose
differently after a mutating action had committed, which made the cache turn
passing tests red on any page whose content moves between runs — the one thing a
cache must not do. A runner that re-decides every action, as this one does, cannot
reach that state, so the code is declared but unreachable here. `suiteVersion` is
bumped for the `cache-1` schema change.

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

Fix `vision` on `agent.act`. `vision: 'only'` withholds the semantic tree, but
planning has to name nodes from it, so every proposal was rejected until the
budget ran out; it is now refused up front with `POLICY_DENIED`, like the located
methods that need a node. `vision: 'fallback'` was a silent no-op for planning —
nothing in the loop ever escalated — and now escalates once, when the model
reports it cannot do what was asked, which is the planning equivalent of a missed
locate.

Report an `agent.act` argument mistake as one. An instruction that is not a string
or falls outside 1..8 KiB, and parameters that are oversized or nested too deeply,
raised `POLICY_DENIED` — a configuration error, which changed the run's exit code
from 1 to 2 and made a typo in a test read as a misconfigured project. They now
raise `INVALID_ARGUMENT` like every other argument check, and are validated before
the step opens.

`--debug` no longer lets a bypassed planning step inflate what the locate cache
saved: `bypassCache` records its entry kind, so only genuine locate rounds price a
locate hit.

An `agent.act` flow can no longer start over. Navigation leaves the offered action
set as soon as the flow commits its first action: before then, navigating only
positions the agent, but afterwards it discards state the calling test built and
cannot restore. A stuck flow was reaching for exactly that, which unwound whole
funnels and left later steps asserting against the wrong screen. A proposal to
navigate after a commit is now rejected as invalid output, and the model is told
why rather than discovering it through a rejection. A flow that genuinely cannot
continue concludes `failure`.

Catch a planning flow that is going in circles, not just one that is stuck on the
spot. Every (screen, action) pair the invocation has proposed is remembered, so a
flow alternating between two controls that do nothing is caught after a couple of
rounds with `STEP_NO_CONCLUSION` instead of spending the entire model-call budget
while the runner reports nothing unusual.

Fix path guidance skipping the step that failed. The guidance cursor advanced when
the model *agreed* with the recorded action rather than when that action actually
committed, so a dispatch that failed left the next round being guided past the one
thing it had just been unable to do. Guidance now advances on commit only.

Fix recorded-path comparison depending on JSON field order. A proposal built from a
live call and an action read back from a cache file were compared with
`JSON.stringify`, so equality held only while two object literals in two modules
happened to list their fields in the same order; a divergence would have silently
discarded valid guidance. Both sides are now serialized with sorted keys.

Bound the keys a planned flow may press. The planning tier is the only place in
the API where a `press` key comes from the model rather than from test code, and it
reached the driver's keyboard unchecked — so `Alt+ArrowLeft`, `BrowserBack`, `F5`,
or `Control+r` bypassed the navigation withdrawal and unwound the flow through the
keyboard instead. The model now chooses from a fixed set of keys that act within
the page, declared as an enum so anything else cannot be sent at all.

Give the model a role instead of addressing it as a mechanism. The system message
opened with "You are the response generator for the e2e test runner" followed by
"You never act on the application" — a framing that described none of the three
tiers and told the one tier that decides what happens next that it was not
responsible for whether anything happened. It is now a QA-engineer role per tier:
planning owns whether the instruction actually finished (verify before concluding,
never start over to escape an obstacle, never call an unfinished flow a success),
selection answers one question about one element, and judgment reports what is on
screen rather than what the test hoped for. The security rules are unchanged in
substance; the "the runner performs every action" fact now sits on the output rule,
where it belongs, rather than leading the message as a disclaimer.

This bumps the agent policy to `policy-0.4`. The policy version is part of the agent
cache key, so every locate and path entry recorded under `policy-0.3` is retired: a
different prompt is a different function, and replaying an entry across that change
would replay a decision this runner would not make. The first run after upgrading is
cold.

Serialize where a node is, so the agent can tell two identical controls apart. The
driver reports a rect for every node and the observation serializer dropped all of
them, so two controls in completely different places on the page produced
byte-identical lines. A line now ends with `(off-screen above|below|left|right)`
when the node is outside the viewport, and with `(at=x,y)` when it would otherwise
read exactly like another line. Neither is an action argument, and neither takes
part in deciding whether the screen changed — position is viewport-relative, and
letting scrolling count as a change would break the runner's refusal to repeat a
submit against an unchanged screen.

Stop truncation dropping the content the flow needs. An observation over
`agent.maxObservationBytes` was cut in document order, and a dialog, drawer, or
sheet is appended at the end of the document — so the thing the user is looking at
was the first thing dropped, while the observation reported only that it had been
truncated. What is inside the viewport is now kept first, with the ancestors that
place it in the tree, and the rest of the budget goes to what is scrolled out of
view. A page that fits the budget is unaffected.

Together these fix a flow that stalled in the same place every run. Tapping a
booking button opened a reservation dialog, which pushed the original button 2350
pixels above the fold and rendered the live one inside the dialog. The live button
fell past the byte limit, and the dead one — identical line, first in document
order — was the only candidate left, so the agent pressed it until the invocation
gave up with `STEP_NO_CONCLUSION`.
