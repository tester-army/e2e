# Replay cache

How `agent.act()` steps are recorded and replayed without a model call, the
rules each stage follows, and where they are tested. The user-facing version
is `docs/cache.mdx`; this file is for people changing the code.

One rule runs through every stage: **fail to miss**. Anything the cache cannot
prove ends in a miss or a hand-off to the agent, never a wrong action and
never a failed step. The only exception is `cache.strict`, which turns a stale
recording into `REPLAY_STALE` on purpose.

## Lifecycle of one step

```
claimKey ─▶ store.read ─▶ decideTraceReplay ─▶ replayTrace ─▶ endStateMatches ─▶ verdict
   │             │                │                  │                │
   │           miss            wrong-context    hand-off at the    end-mismatch
   │             │             / truncated      first divergence        │
   ▼             ▼                ▼                  ▼                ▼
 recorder ◀──────────────── the agent runs the step (from the top or mid-step)
   │
   ▼
conclude ─▶ staged (write | keep) ─▶ flushStagedTraces at attempt end
```

| Stage | Code | What it decides |
| --- | --- | --- |
| Key | `identity.ts`, `context.ts` (`claimKey`) | Which entry belongs to this step. |
| Read | `store.ts`, `trace.ts` (`readTraceEntry`), `template.ts` (`expandTrace`) | Whether a trusted entry exists, with this call's `unique()` values filled in. |
| Precondition | `decide.ts`, `route.ts` | Whether the app is on the screen the recording began on. |
| Replay | `agent/replay.ts`, `locate.ts` | Each recorded action, re-aimed at the live screen. |
| Postcondition | `anchors.ts`, `locate.ts`, `agent/step-cache.ts` (`endStateMatches`) | Whether the replay reproduced the recorded effect, and caused it. |
| Write | `recorder.ts`, `agent/step-cache.ts` (`stage`, `conclude`) | What to stage: a new recording, a keep, or an eviction. |
| Settle | `context.ts` (`flushStagedTraces`) | Which staged entries a later verification confirmed. |
| Strict | `rekeyed.ts`, `agent/step-cache.ts` (`failIfStale`) | Whether a missing or diverging recording fails the step. |

`agent/step-cache.ts` (`StepTraceSession`) owns everything cache-shaped about
one step. The dispatch owns budgets, the grammar, and the verdict.

## Key

The key (`TraceCacheKey`) is a JCS SHA-256 over every field that can change
what a replay does: project, test, target, platform, engine name and
major.minor, SPI version, kind, instruction digest, params digest (each
`unique()` value as a placeholder), occurrence index, app identity, agent
name, agent context digest, and `REPLAY_POLICY_VERSION`. A stale entry can
only be a miss, never a wrong answer.

The occurrence index (`callIndex`) counts repeats of the same signature
(instruction and params) per agent, not every step. An optional cookie dialog
that appears on one run and not the next renumbers nothing else.

Bump `REPLAY_POLICY_VERSION` only when an existing recording could now
relocate to a different node than it did before. Rules that only add
fallbacks after the exact match fails do not need a bump: an entry that
replayed before still matches the same node first.

## Locating a recorded node

Every lookup the cache makes goes through one locator (`locate.ts`): a
replayed action's target (`relocateWithFallbacks`), a node a live step saw a
moment ago (`relocateExact`), an end-state anchor (`locatePresent`), and a
target's place among its twins at record time (`describePosition`). Each
splits what was recorded into identity, which node it is, and content, what
it must read or be:

- The candidates are the nodes that carry the content: a tapped toggle's
  state for a target; the value, states, text, and sometimes the name for an
  anchor (see Anchors). A target is also held to its recorded container
  (`within`); anchors record none, so every node of the screen is a
  candidate.
- The identity walks the ladder below over those candidates.
- Nodes still carrying the recorded test id veto a pick made without it,
  whatever they read, so the same reading elsewhere is never taken for them.
- A target needs exactly one node, or its recorded place among the same
  count of twins. An anchor takes any match: an effect shown twice is shown.

Content is never loosened. A wrong action target usually fails a later check;
a wrong anchor pick passes the step, and nothing checks after it.

## Relocation: the ladder

A recorded target is a descriptor (`TraceTargetDescriptor`): role, name,
text, test id, placeholder, input purpose, plus `within` (the key of its
named row, list item, or group) and `position` (its place among twins).
Engines fill the first six from the node; the web engine does not emit
per-node `selector`s, so the selector is provenance only and never matched.

`relocateWithFallbacks` walks a ladder. Each rung keeps less of the recording,
most stable evidence first. The first rung that settles on exactly one node
(or on the recorded `position` among the same count of twins) wins.

| Rung | Matches on | Absorbs | Report |
| --- | --- | --- | --- |
| Exact | every recorded identity field (text too when there is no name or test id) | nothing | none |
| Exact, test id re-minted | every field but the test id, when no node still carries the recorded test id | test ids minted per render | none |
| Test id + role | `testId`, `role` | copy changes: name, text, placeholder | `test-id` |
| Test id | `testId` | copy and role changes | `test-id` |
| Accessible | `role`, `name` | test id, placeholder, or text changes | `accessible` |
| Role family | `name`, role in the same family | `link` to `button`, `checkbox` to `switch`, `textbox` to `combobox` | `role-family` |

Every rung compares fields as they read; no rung reads a label by its shape
(`Like (0 likes)` as `Like (1 like)`). That would take word rules (plurals,
relative times, which numbers count and which name), and a control whose
label carries state is better served by a test id.

What never loosens:

- A toggle (`TOGGLE_ROLES`: checkbox, switch, radio, and their menu item
  forms) a tap or double tap acted on records the state it was in, and
  relocates only onto one in the same state on every rung. A tap flips it:
  a recording that unchecked a box the model had checked by accident would
  otherwise check it on a replay where the accident never happened.
- `within` must hold on every rung. It is the first text of the nearest
  named row, list item, or group, unless that text is the label of another
  control of the target's own role: then the "container" is a list and the
  text is its first row, which a scroll changes. The same "Delete" in
  another row is another control, and with only one row left the ladder
  would otherwise delete the wrong record.
- An ambiguous exact match diverges. Every fallback rung only widens the
  candidate set, so falling back cannot resolve it.
- A control recorded among twins resolves only by its place among the same
  count of them, on every rung. A lone survivor of three recorded "Like"
  buttons is ambiguous, not found: it is whichever one still reads as
  recorded, which after an earlier run liked the recorded one is the wrong
  one.
- An anonymous control (role only) has no fallback. Its recorded place among
  its unnamed twins is all it has.
- Two kinds of evidence that disagree hand off. When the test id rungs settle
  on one node and the name rungs on another, the result is `target-ambiguous`.
  The same check guards the exact tier: a re-minted test id is forgiven only
  when no node still carries the recorded one.
- A fallback match needs a second look (`sightingKey` in
  `agent/replay.ts`). A node found only by a fallback is acted on once the
  next raw look finds the same node by the same rung, in the same box,
  again. A wizard's
  outgoing page can hold "Next" under the test id of the incoming page's
  "Save"; the second look sees the page that replaced it. This costs one
  more poll of the settling backoff per drifted control (100 ms when the
  first look found it), nothing for exact matches.
- When the test id and the name disagree, the result is a conflict, not
  look-alikes: a recorded point never picks between them, and the replay
  keeps looking while the screen settles before it hands off.

Live steps (`observation-feed.ts`, re-finding a node that went stale a moment
ago) use the exact match only (`relocateExact`), the moved-test-id check
included. The ladder is for recordings made on another day.

### Healing

A replay that passed after a fallback re-records the step in `read-write`
mode instead of keeping the entry. The dispatch records every replayed action
against the live node, so the staged trace carries today's descriptors and
anchors, and the next run matches exactly. The entry is written only once a
later verification confirms it, like any recording. In `read-only` mode the
entry keeps replaying through the fallback; `step.cache.relocated` (report),
`relocated` (run summary), and `agent_steps_relocated` (telemetry) make that
visible.

## A replayed action that never reached the app

An action the engine refused before sending any input (`NODE_STALE`,
`FRAME_NOT_FOUND`, `NOT_ACTIONABLE`) gets one more try: the replay waits for
the screen to hold still, finds the target again, and repeats it. A tap on a
row a debounced list re-rendered is the usual case. Any other action failure,
an engine fault or a timeout included, may have reached the app and hands off
to the executor. Cancellation and runtime hard stops are not hand-offs: they
end the step.

## Pacing

A replay runs no model, so its speed is set by how long it waits for the
app. Most actions arm a change wait (`SETTLE_AFTER` in
`agent/settle-policy.ts`): the next settled look waits for the screen to
leave the shape the action was resolved against, up to 2 s after a tap,
key, fill, or navigation and 500 ms after a scroll or a project tool, then
reads the first capture after it (`after-change`, after a fill) or waits for
it to hold still (`held-still`, after the rest). A secret fill arms none. An
action whose effect the tree never shows (a right-click that opens a native
menu, a key that moves a caret, a tap that only arms the next control) waits
its whole change wait every time.

The recording notes how each action settled. `TraceRecorder.record` returns
a settle note for the action, the dispatcher arms the action's change wait
with it (`ObservationFeed.armChange`), and the settled look that consumes the
wait answers it: whether any capture left the shape the action was resolved
against (a save that showed "Saving..." and came back did change the
screen). An action that changed nothing is stored `quiet`. A note answers
for one action only: a second wait armed before the look drops both notes,
and a note goes stale once anything else is recorded before the look.

A replay runs a quiet action at a 300 ms change wait instead
(`QUIET_CHANGE_WAIT_MS`, `ActionDispatcher.withChangeWait`, scoped to the
call), so it is paced by what the recording saw rather than by timeouts.
The held-still check after it, relocation polling, and the end-state wait
are unchanged, so a change that does come late is still waited for. A
folded scroll is always paced in full.

`quiet` is a timing, so it never counts as a new flow (`flowOf`). An entry
recorded before pacing learns it from the next recording of the same flow.

## Anchors: the postcondition

Actions that ran prove the clicks happened, not that the save took. A
recording keeps the step's delta (`describeDelta`): up to eight descriptors
that appeared and eight that vanished, announcements (`alert`, `alertdialog`,
`status`) first, then leaves, then containers. A replay passes alone only
when:

1. the end route matches (`sameRoute`, polled while a navigation commits),
2. every appeared anchor is present and every gone one is absent
   (`deltaHolds`), found by the locator with their content as recorded,
3. no alert is on screen that was not there before and was not recorded,
4. at least one change happened during the replay (`deltaEvidenced`),
   measured from the first screen the replay saw on its end route. An
   outcome already on screen proves nothing.

An anchor's name and text are compared by shape (`anchorShape`): ids,
dates, times, and durations read as `#`, so `Saved at 10:42` is the effect
`Saved at 10:45` repeats. A field's value is compared exactly: a picked date
is the effect. Shapes are weaker than exact text, so volatile anchors are
recorded only when nothing stable changed (alerts always). Labels that read
alike (a status, and a wrapper named after it, which one iOS backend reports
and another omits) are one anchor (`onePerLabel`), a leaf with a test id
preferred. Counts that name what they
count (`3 records imported`) are the step's result when the step made them
appear on its own screen, and data otherwise.

An anchor's content is its value and states, its text, and its name when the
name is all it says (a text node, a button that now reads "Following"). The
rest (role, test id, the name of a region that also has text) is identity
and walks the ladder: a status found by its test id still counts after the
region around it was relabeled, or after an iOS backend reports its role
another way. An anchor whose identity is only a role (an unnamed text node),
or whose test id the app re-minted, is matched on every field at once
instead, with no ladder.

## Routes

`route.ts` reduces a location to a route: origin (dropped on the app's own
origin, so a recording follows the app to a preview deployment), path
segments, and sorted query terms. Segments and values that look minted per
record (uuids, hex and digit runs, long mixed tokens, prefixed ids like
`INV-2041`, dates, text with whitespace) become `:id`. Fragment routers
(`#/x` and `#!/x`) route by the fragment. A device screen title
(`<bundle id> / <title>`) is not a URL; its words follow the segment rules,
so `Order 48213` and `Order 48214` are one screen.

A replay starts only on the route its recording began on. A step that begins
on another one waits for it on the settling backoff (`awaitStartRoute`)
before it misses as `wrong-context`: the app may still be on its way there,
a payment sheet it presents once a request returns.

## `unique()` templates

A value marked `unique()` is a slot: the key digests a placeholder
(`{{param:<pointer>}}`), the recording stores the placeholder wherever the
value appeared in any spelling (as given, `uri`, `form`, `slug`), and replay
fills it from the current call. A pointer is percent-escaped for `%`, `|`,
and `}` so any param key round-trips. A `unique()` value that another param
spells is a collision: the step is not recorded (`notRecorded:
param-collision`).

## Write side

`StepTraceSession.conclude`, in `read-write` mode only:

| Step ended | After | Staged |
| --- | --- | --- |
| passed | the agent had to act after an `end-mismatch` | evict: the flow is proven not to produce the effect |
| passed | a whole replay, every control exact | `keep`: the file stays byte for byte |
| passed | a whole replay that used a fallback | `write`: heal (see above) |
| passed | a live run or a hand-off | `write` of what was recorded, or evict the read entry when nothing is recordable; after an entry that did not serve the step (anything but a gap), the write replaces it even as the same flow, so a stale `quiet` mark cannot outlive it |
| failed | a replay ran any action | evict, unless `cache.strict` failed it |
| no verdict | cancelled, or no model answered | nothing |

`flushStagedTraces` confirms a staged entry only when a verification step
(a locator or engine matcher, `agent.assert`, `agent.waitFor`) passed after
it. On a failed attempt, confirmation stops at what had been verified when
the first failure landed, a soft assertion included. Unconfirmed entries are
evicted, unless every failure was a model that never answered.

A write is skipped when the stored entry already holds the same flow
(`holdsSameFlow`, ignoring the summary, the measured end wait, and a gap's
`derived` rule), so a committed cache directory stays clean across runs.

## Testing map

| Area | Tests |
| --- | --- |
| Ladder, conflicts, `within`, position | `tests/unit/relocate-ladder.test.ts`, `relocate-*.test.ts` |
| Replay engine, second look, scrolls, points | `tests/unit/trace-replay.test.ts` |
| Anchors and shapes | `tests/unit/trace-anchors.test.ts` |
| Routes | `tests/unit/trace-route.test.ts`, `trace-decide.test.ts` |
| Templates | `tests/unit/trace-template.test.ts` |
| Key, store, entry format | `trace-identity`, `trace-store`, `trace-cache`, `trace-recorder`, `trace-redaction` |
| Session write side, strict, healing | `tests/unit/step-cache.test.ts` |
| Pacing | `tests/unit/trace-pacing.test.ts`, the `/arm` case in `agent-trace-cache.test.ts` |
| End to end with a browser | `tests/integration/agent-trace-cache.test.ts`, `trace-cache-replay.test.ts` |
| Real apps | `apps/web-benchmark` (`--strict-cache` in CI), `apps/mobile-benchmark` |

## Live drift probe

Unit tests cannot show that a replay against a changed app does the right
thing end to end. The probe that checks it is a scratch server whose pages
differ between a `record` and a `drift` mode, run through the real CLI and a
real model: record once, copy the entries to each build, replay. Not
committed (the dead-code check rejects its server); rebuild it from this
table when a rule here changes, and run it on `main` and the branch.

| Page | Drift | Expected |
| --- | --- | --- |
| counter | `Increment` does nothing | `end-mismatch`, never a pass on `Count: 0` |
| items | `Delete item 3` gone, `Delete item 4` left | `target-not-found`, item 4 untouched |
| form | field id `mat-input-2` moves to another field | replays by label |
| testid | `Save` relabeled `Save changes`, same test id | replays, `test-id`, heals |
| likes | `Like (0 likes)` to `Like (3 likes)`, no test id | hands off (no shape rung) |
| settings | link becomes a button | replays, `role-family`, heals |
| clock | none; the effect reads the time | replays |
| async | none; the control renders 1.2 s after load | replays after relocation polling |
| shuffle | none; rows in random order | replays on the named row |
| ago | `posted 2m ago` to `posted 5m ago`, no test id | hands off (no shape rung) |
| confirm | a new confirm dialog after Delete | `end-mismatch` on the new alert, evicted, re-recorded |
| removed | the control is gone | `target-not-found` |
| ab | label picked per load under a stable test id | replays, `test-id` |

## Known limits

- `--repeat-each` repeats share one key; concurrent repeats can evict an
  entry another repeat just confirmed. The CLI help already suggests
  `--no-cache` with it.
- `within` never loosens. A row whose first text changed makes its controls
  unreachable until a re-record. Loosening it risks acting on the wrong row.
- A label that carries state (`Inbox (3)`, `Like (0 likes)`, `Bob · 2m`)
  with a stable test id replays through the test id rung and heals every
  `read-write` run, which rewrites the entry each time. Without a test id
  it hands off once the state moves.
- The non-test-id rungs accept a candidate whose own test id differs from
  the recorded one, as the re-minted tier always has. A real, stable test id
  that changed on purpose is caught only by the end anchors.
