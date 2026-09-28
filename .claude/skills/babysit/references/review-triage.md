# Review triage

How to decide on a review finding, whoever posted it. Bots come and go and
change behavior; this file names none of them. Learn who is reviewing a PR
from `pr-status.ts` (thread and comment authors, check names), not from a
list.

## Every finding

1. Read the code it points at, and its callers, before deciding.
2. Check the claim against the current head. Findings go stale: a later
   commit may already fix it, or it may cite lines that moved.
3. Reproduce it when you can: a failing unit test, an integration fixture
   project, or a testbed page. A finding you reproduced is a fix; one you
   could not reproduce needs a disproof from the code, not a shrug.
4. Decide: **fix**, **dismiss with a disproof**, or **escalate**.

## Fix

A plausible defect in code this PR adds or changes: wrong behavior, a
security invariant break, a race, a broken contract. Fix it in this PR with
a test that fails without the fix, reply with the commit, resolve.

## Dismiss with a disproof

Reply with the one fact that disproves it, then resolve. Common shapes:

- **Pre-existing.** `git blame` or `git log -L` shows the flagged lines
  predate the branch. A real, cheap issue gets a follow-up, not scope creep.
- **Misread library semantics.** Cite the library source or docs (Playwright,
  the AI SDK, agent-device, node).
- **Already guaranteed.** Name the shared helper, type, closed schema, or
  `e2e/engine` contract that makes it impossible.
- **Intentional tradeoff.** Link the PR body line, the commit body, or the
  `AGENTS.md` rule that states it.
- **A tool rule that contradicts a repo rule** in `AGENTS.md`. Cite the repo
  rule.

## Escalate, never dismiss alone

The security invariants in `AGENTS.md` (secrets, fill authorization, tool
call authorization, navigation policy, sessions, report escaping), the public
contract (`dist/*.d.ts`, `tests/types/sdk-types.ts`, `e2e/engine`), wire
schemas, peer ranges and release config, and CI gating (`filters.yml`,
required checks). Fix it, or reply, leave the thread unresolved, and name it
in the handoff.

## Stop the loop

A reviewer that answers every fix with a narrower edge case in the same
function is hardening a heuristic, not finding bugs. After two rounds on the
same function, reply that the remaining cases are out of scope and name them
in the handoff.

## Patterns reviewers keep catching here

Code patterns, not bot behavior. The `ship-pr` self-review checks these
before any reviewer does.

1. Deadline arithmetic: a short remaining budget skips work that would have
   succeeded, or an expired deadline accepts a transitional or empty screen.
2. One failure masquerading as another error code: a store outage read as a
   stale recording, a swipe timeout read as `LOCATOR_NOT_FOUND`, an operation
   timeout read as `STEP_TIMEOUT`.
3. Secrets reaching an artifact, download, session envelope, report, or
   model input through a path the redaction does not cover.
4. Trace cache keys or entries not changing when an input does (launch
   arguments, permissions, `unique()` values, URL encoding), so replay picks
   the wrong action; recordings evicted by a failure that was not theirs.
5. In-page code trusting the page: app overrides of `JSON.stringify`,
   `Function.prototype.toString`, prototypes, or `instanceof` across frames.
6. Hidden nodes, frames, or options entering an observation, or a
   visibility filter that one query path applies and another skips.
7. String edge cases: substring vs exact match (`Row 12` vs `Row 120`),
   whitespace-only values collapsed away, Unicode slicing, BOMs, filename
   byte limits.
8. Reruns and repeats: `--last-failed`, `--repeat-each`, and retries losing
   evidence, or a folded report and its GitHub comment disagreeing.
9. A value the code accepts that the wire schema rejects, or the reverse.
10. Process lifecycle: a signal, timeout, or cleanup path that leaves a
    process, handler, or terminal state behind.
11. Platform leaks: macOS-only tools in an Android path, POSIX paths or
    symlinks on Windows.
12. A new build input or benchmark dependency missing from
    `.github/filters.yml`, so the benchmark suites skip a change they cover.
13. Core naming an engine noun (`Web`, `browser`, `page`, `route`,
    `playwright`) outside the `init` presets.

## Keeping this file useful

Add a dismissal shape or a code pattern only when it is about the code or
the repo, never about a specific bot. When the same pattern gets caught
twice, it belongs in a lint rule, a type, or a test, not here: propose one,
and delete the line once it lands.
