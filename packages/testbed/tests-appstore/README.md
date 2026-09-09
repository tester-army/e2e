# App Store readiness audit

An experiment: `e2e` + `@e2edev/agent-device` as an App Review rehearsal. The
agent opens a third-party iOS app on a simulator, tours it the way a reviewer
does, and records a verdict per App Store Review Guideline it can observe from
the UI. The output is a readiness report, the kind of artifact a team wants
before submitting and the kind a testing service can hand out for free.

## Run it

```bash
# an app already on the booted simulator, by bundle id or display name
AI_GATEWAY_API_KEY=... E2E_APP=com.example.myapp pnpm --filter @e2edev/testbed test:appstore

# a simulator build; installed once, then opened fresh for every check
AI_GATEWAY_API_KEY=... E2E_APP_PATH=build/MyApp.app pnpm --filter @e2edev/testbed test:appstore
```

Without `E2E_APP` or `E2E_APP_PATH` the suite audits Apple's Reminders as a
smoke target. `E2E_MODEL` picks the gateway model. Requires Xcode with a booted
iOS simulator; run `npx agent-device doctor` once. Every check spends real
model calls, so this suite is manual and never runs in CI.

The script clears the previous findings, runs the suite, then renders
`.e2e/appstore/report.md` with `scripts/appstore-report.mjs`. The process exit
code is the readiness call: 1 when a rejection-level violation was found or a
check did not reach a verdict.

## What it checks

| Guideline | Check | How |
| --- | --- | --- |
| 2.1 App Completeness | Every top-level screen loads with finished content, no placeholder or beta copy | Enumerates navigation destinations, opens each, judges the screen |
| 2.1 App Completeness | Launches and explains itself with no network | `device.setNetwork('offline')`, relaunch, judge the state |
| 5.1.1(i) Privacy Policies | Privacy policy reachable in-app | Looks in settings, profile, about, help, sign-in, paywall |
| 5.1.1(iv) Access | Works with the tested permissions denied | Denies camera, microphone, photos, contacts, location, notifications, and calendar, relaunches, uses the app |
| 5.1.1(ii) Permission strings | Prompts explain why access is needed | Resets permissions, triggers prompts, reads the purpose text, dismisses |
| 4.8 Login Services | Sign in with Apple next to third-party login | Opens the sign-in screen and reads the providers |
| 5.1.1(v) Account Sign-In | Usable without an account (advisory) | Same screen |
| 5.1.1(v) Account Sign-In | Account deletion offered in-app | Only when a signed-in session is present; `unverified` otherwise |
| 3.1.1 In-App Purchase | Digital goods sold through IAP, no steering | Opens the paywall or store, stops before any purchase sheet |
| 3.1.2 Subscriptions | Price, period, auto-renewal, Terms and Privacy links | Same screen |
| 1.2 User-Generated Content | Report and block controls | Opens one post or profile and reveals its actions |
| 4.2 Minimum Functionality | Native app, not a wrapped website (advisory) | Vision judgment of the main screen |
| 4.0 Design | Legible in dark mode (advisory) | `device.setAppearance('dark')`, relaunch, vision judgment |

Every check ends in one of four verdicts. `compliant` and `violation` are
judgments; `not-applicable` means the feature the guideline governs is not in
the app; `unverified` means the agent could not reach the evidence (a login
wall with no credentials, a payment mechanism that cannot be told from the
screen). Only a rejection-level `violation` fails the runner test; advisory
violations, `not-applicable`, and `unverified` show up in the report alone.

## Agent knowledge

Everything the agent is told beyond the step instruction is plain markdown
under `context/`, injected into the prompt:

| File | Reaches | How |
| --- | --- | --- |
| `reviewer.md` | every `act` step | `agent.context` in the config |
| `guidelines.md` | every check, including `extract` | spread into each test's options as `RUBRIC` |

`extract` reads the test's `agentContext` and never runs through the
executor, which is why the rubric travels with the tests rather than the
config. A customer's own notes (where the paywall is, how to reach a
signed-in state) are one more markdown file appended to `reviewer.md`.

## How a check is built

Each test is navigate, judge, conclude:

1. `agent.act` opens the screen that holds the evidence, with an explicit
   "if it does not exist, stop where you are" clause.
2. `judge` screenshots the screen and asks `agent.extract` for
   `{ verdict, summary, evidence }` against the rubric in the test's context.
   The question names what is compliant, a violation, or not applicable.
3. `conclude`, handed to the body by `audit(title, tags, body)`, appends the
   findings to `.e2e/appstore/findings.jsonl` under the test's title and
   throws on a rejection-level violation. The report matches findings to
   runner results by that title, so two checks under one guideline stay
   apart, and resolves each screenshot to the last attempt's artifact path.

The tour and the permission-prompt loop call `judge` once per screen and
fold the results with `merge`, which keeps the worst verdict. The tour
confirms each destination was reached before judging it, and files the ones
past its cap of six as `unverified` rather than not at all.

## Not covered

Anything App Review checks outside the running app: metadata, screenshots,
age rating, privacy nutrition labels, entitlements, crash logs, iPad layout
(2.4.1), and Sign in with Apple's own flow. Controls that do nothing when
tapped are not probed, only screens that fail to load. Verdicts are an AI
agent reading an accessibility tree and screenshots: a first pass to run
before a human review, not a review outcome.
