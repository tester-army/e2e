# Running a bug bash

A bug bash is many `e2e explore` runs at once, one charter each, followed by
a verification pass that turns every claimed bug into a repro test that
fails for the reason reported. Explorers find candidates cheaply on the
project's model. You, the coding agent, plan the charters, fan them out,
merge what comes back, and prove each bug before reporting it. What reaches
the user is a list of confirmed bugs, each with a failing test, the explorer's
screenshot, and its steps.

Use it when asked to bug bash, QA, or hunt for bugs in an app or a branch,
and when a change needs a broad look before review. For one flow, a single
`e2e explore` (topic `explore`) is enough.

## 1. Prepare

- A config with a target and an agent that holds a model (topic `setup`),
  and authentication for its provider.
- The app must serve several explorers at once. Either start it once and
  make the target's `command` set `reuseExisting: true`, so every run
  reuses the server that already answers, or declare the URL with port `0`,
  so each run starts its own app on a free port (isolated state, one app
  process per run). `reuseExisting` is ignored when `CI` is set, as it is in
  many agent sandboxes: there, use port `0` or run with `CI` unset. A fixed
  port that is not reused fails every run after the first.
- When the target also declares `services` with a `teardown` (a database
  started with `docker compose up` and removed with `docker compose down
  --volumes`), every explorer would start and tear down its own copy, and
  the first to finish removes the database under the rest. Start the stack
  once yourself, with the same commands and environment the config gives
  them, and explore with a bug-bash config that points at the running app
  and declares no services or command (below).
- Explore a production build when the project has one. A dev server that
  compiles a route on its first visit reads to the explorer as a link that
  does nothing.
- Give every charter its own data and its own account: seed one disposable
  workspace or user per charter with the project's own fixtures or seed
  scripts, and declare each as a credential (`bb-<slug>`). Explorers that
  share an account edit each other's state and report the result as bugs.
- Start signed-in charters from a saved session when the project has a
  setup test that signs in: `e2e explore --session <name>` runs that setup
  and explores signed in (topic `explore`). A setup that signs in without
  filling a password (a cookie, an API call) keeps screenshots available,
  where the engine captures them; a charter that types a password itself
  gets none after that point. Charters that need their own account each need their own
  setup and session.
- Tell the explorers what the local app cannot do, in the agent's
  `context`: which integrations have no keys (email, payments, an AI
  provider), what is seed data, and what must never be clicked (starting
  paid runs, connecting real accounts). Otherwise a large share of the
  findings are the missing keys.
- Each exploration step needs a budget of 40 actions and model calls or
  more (`maxSteps` and `maxModelCalls` on the agent); a project config tuned
  for short test steps (`maxSteps: 15`) starves it. That is a per-step
  budget, separate from `--max-steps`, which counts the exploration steps a
  charter plans.
- On a mobile target, every explorer and every verifier needs its own
  simulator or emulator: declare one target per device, each naming its
  `device`, and give each charter its own target. Two on one device fight
  over it.
- Skip `--headed`: several browsers at once are only noise. `--video` records
  each run so a confirmed bug comes with a replay.

A bug-bash config, left untracked, spreads the project's and replaces what
a bug bash needs different:

```ts
// e2e.bugbash.config.ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';
import base from './e2e.config.ts';

export default {
  ...base,
  // The project's tests, so a repro can use its setup tests' sessions, plus the repro tests from step 6.
  tests: [base.tests ?? 'tests/**/*.e2e.ts', 'tests/bugbash/**/*.e2e.ts'].flat(),
  // The app already runs: no services, no command.
  targets: [{ name: 'web', platform: 'web', engine: web({ url: 'http://127.0.0.1:3000' }) }],
  retries: 0,
  reporters: ['list'],
  credentials: {
    ...base.credentials,
    // The seed script's password, from the environment rather than the file.
    'bb-cart': { username: 'bb-cart@example.test', password: process.env.BUGBASH_PASSWORD ?? '' },
    'bb-account': { username: 'bb-account@example.test', password: process.env.BUGBASH_PASSWORD ?? '' },
  },
  agents: {
    default: {
      model: gateway('openai/gpt-6-luna-fast'),
      maxSteps: 40,
      maxModelCalls: 40,
      context: 'Sign in with the credential the goal names. The local app sends no email and has no AI key. Never start a paid run or connect an integration.',
    },
  },
} satisfies E2EConfig;
```

When you use one, pass `--config e2e.bugbash.config.ts` to every command
below.

## 2. Plan charters

A charter is one `e2e explore` goal: one area of the app and one posture,
in one sentence, naming the route to start from and, when the app needs
one, the credential to sign in with (`Sign in as credential bb-cart.
Starting at /cart, ...`). Read the app before you
write them: the routes, the navigation, the forms, and, for a branch,
`git diff --stat` against the base, so the charters land on what changed.

| Posture | Charter shape |
| --- | --- |
| First-time user | `Starting at /signup, sign up and complete onboarding like a first-time user; report anything confusing, broken, or inconsistent` |
| Numbers and copy | `Starting at /cart, change quantities and apply a coupon; check every price, total, and label against the rest of the page` |
| Edge input | `Starting at /settings/profile, submit each field empty, too long, with unicode and with leading spaces; report validation that is missing or wrong` |
| State | `Starting at /projects, create, rename, and delete a project, reloading and going back after each; report state that is lost or stale` |
| Error paths | `Starting at /login, try a wrong password, an unknown account, and a locked account; report errors that are missing, misleading, or leak detail` |

Aim for five to ten charters. Each gets its own slug for its output
directory. Overlap between charters is fine; duplicates are merged in step 4.

## 3. Fan out

One `e2e explore` per charter, each with its own output directory, so
reports never overwrite each other: `--output .e2e/bugbash/<slug>` writes
`.e2e/bugbash/<slug>/report.json` and the attempt's files under
`.e2e/bugbash/<slug>/artifacts/`, and `--reporter list,markdown` the
`summary.md` beside the report.

Run them as background shell jobs, four at a time. The explorer is the
project's model and needs no supervision: a subagent per charter only
spends your tokens on watching one command. Write one line per charter,
`slug|target|charter`, then:

```bash
mkdir -p .e2e/bugbash
cat > .e2e/bugbash/charters.txt <<'CHARTERS'
cart|web|Starting at /cart, change quantities and apply a coupon; check every price, total, and label against the rest of the page
account|web|Starting at /settings/profile, submit each field empty, too long, and with unicode; report validation that is missing or wrong
CHARTERS
while IFS='|' read -r slug target charter; do
  [ -n "$slug" ] && printf '%s\0%s\0%s\0' "$slug" "$target" "$charter"
done < .e2e/bugbash/charters.txt | xargs -0 -n 3 -P 4 sh -c \
  'npx e2e explore "$3" --target "$2" --output ".e2e/bugbash/$1" --max-steps 6 --video --reporter list,markdown < /dev/null > ".e2e/bugbash/$1.log" 2>&1' _
```

Each run takes a minute or a few and costs what its model calls cost; the
last lines of its log print both. Exit code `1` means issues were reported,
which is the point: read the log either way. Exit codes `2` and `3` are
setup and environment problems; the log says which. Fix them and rerun that
charter alone.

## 4. Merge

Each charter's log lists its findings, issues first and the most severe
first: the title, kind, and severity, where it was seen, expected against
actual, the steps, and the screenshot as `evidence`. `summary.md` holds the
same. The video is under `.e2e/bugbash/<slug>/artifacts/`, in the attempt's
`video/` directory. `report.json` has the record under `run.explore` when
you need a field the log does not print (topic `explore`).

Merge findings that describe one defect: same path and the same broken
behavior, whatever the wording. Keep the clearest reproduction and every
charter that hit it. Keep warnings in a separate list; they are polish, not
bugs, unless the user asked for polish.

A charter that filled a password, or started from a session whose setup
filled one, has no screenshots after that point: pixels are withheld once a
secret is on screen, so its findings print no `evidence` line. Its video still shows what happened, but a video is not
masked: before you share one, check that no secret shows in it (a password
field the app lets you reveal, a token echoed on screen).

## 5. Triage

Sort every finding before writing any test. Reading the app's source, when
you may, settles most of them in a minute each:

| Bucket | Sign | Outcome |
| --- | --- | --- |
| Environment | Fails on a key, a service, or a limit only the local stack lacks (an email provider, an AI key, a billing plan) | Rejected, naming the variable or service; note separately when the app handles the failure badly in a way production users would see, such as showing the raw error |
| Design | The code, its tests, or its copy say the behavior is intended | Rejected, citing where |
| Fixture | The seed data lacks a field real records always have | Rejected, naming the field |
| Candidate | None of the above | Verify it (step 6) |

## 6. Verify

A finding is a model's claim. Prove each candidate before you report it.
Verification is the slow part, so run it in parallel: when your client can
start subagents (Claude Code's Agent or Task tool, for one), start one per
area with its three to five candidates, as the log printed them, and these
steps, up to four at a time, the `e2e mcp` server's default session limit.
A verifier that holds an area's findings together spots a shared root cause
and sets up the app once. Each verifier opens its own session and reports
back, per finding, confirmed or rejected, the root cause as `file:line`
when it may read the source, the repro test path, and the failure it saw.
Without subagents, verify one area after another.

1. Read `actual` against the screenshot, or the video when there is none.
   A finding the evidence contradicts is rejected here.
2. Write a repro test that follows the reproduction and asserts the
   expected behavior, so it fails today and passes once the bug is fixed.
   Put it under `bugbash/` inside the directory the config's `tests` glob
   covers (`tests/bugbash/<slug>.e2e.ts` for the default
   `tests/**/*.e2e.ts`): a file the glob does not match is never selected,
   whatever path you pass to `e2e run`. When the project's own fixtures
   seed data and sign in (a `test.extend` fixture, a setup test's
   session), build on them. Prefer `screen` actions and
   `expect` with exact values; use `agent.act` for a step that varies and
   `agent.assert` for an outcome only judgment can check (topic
   `writing-tests`). Tag it `{ tags: ['bugbash'] }`.
3. Get exact locators from the live app: with the `e2e mcp` server
   registered, open your own session (`open_session`, then pass its session
   id to every call), walk the reproduction, and `locate` each locator
   before writing it (topic `mcp`). Several verifiers can each hold a
   session at once; close yours when done.
4. Run it with the config that holds the model, naming the file so the
   rest of the suite stays out of the run:
   `npx e2e run tests/bugbash/<slug>.e2e.ts`. The bug is confirmed
   only when the test fails with `ASSERTION_FAILED` on the assertion that
   encodes it. Any other failure (`LOCATOR_NOT_FOUND`, a timeout, a setup
   error) means the test is wrong: fix it and rerun. A test that passes
   means the bug did not reproduce; reject the finding and say so, and move
   that test out of `tests/bugbash/` (to `.e2e/bugbash/extra-tests/`, or
   offer it as a regression test): only failing repro tests stay there.

## 7. Report

Lead with the confirmed bugs, most severe first. For each: the title, the
path, one line of expected against actual, the root cause when known, the
steps, the screenshot and video paths, the repro test, and the charters
that found it. Then the candidates the environment triage surfaced as
production risks, marked unverified. Then the rejected findings grouped by
reason (environment, design, fixture, did not reproduce), and the warnings.
End with the charters run, their cost, and the areas no charter reached.

The repro tests fail until the bugs are fixed. Where the project's own
`tests` glob covers `tests/bugbash/`, its gating run must leave them out
until then (`npx e2e run --exclude-tag bugbash`), or keep them
uncommitted. Offer to fix each bug:
the repro test turning green is the proof, and it stays behind as the
regression test, its `bugbash` tag removed.

## Rules

- Never report an unverified finding as a bug. "The explorer reported" is
  not "confirmed".
- One charter, one area. A charter that spans the whole app ends at its
  step budget having skimmed everything.
- Read reports; never edit what a run wrote under `.e2e/`. Delete
  `.e2e/bugbash/` before a new bug bash so old findings do not mix in.
- Seeded data and test accounts the app ships for development are not
  bugs; say so in the agent's `context` when the app has them.
- Leave the project's own files as you found them: the bug-bash config, the
  seed script, and the repro tests are untracked until the user asks
  otherwise, and the stack you started is stopped when the user is done
  with it.
