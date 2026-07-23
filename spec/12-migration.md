# 12 — Migration: Playwright & Maestro Parity

`e2e` aims to replace Playwright (web) **and** Maestro (mobile) with one
cross-platform API — with the agent tiers layered on top. Starting from
scratch is the advantage: we take the best of both and fix what each got
wrong (Playwright's web-lock and config sprawl; Maestro's YAML ceilings and
weak assertions).

These tables are the parity contract. Every row is either mapped, planned
(P1/P2), or rejected with a reason — a migrator should never discover a
hole we didn't document. This doc is also the Phase 1 checklist
(PLAN.md).

## Adoption path (the Vitest move)

Nobody rewrites a working suite on day one — Vitest won by making
coexistence cheap, and so does e2e:

1. **Run alongside.** e2e lives in `tests/**/*.e2e.ts`; the existing
   Playwright suite keeps running untouched. Two runners, one repo, no
   conflict — e2e uses Playwright as its driver anyway.
2. **New tests first.** New flows are written in e2e (agentic where it
   pays, parity surface everywhere else). The migration tables mean zero
   dead ends when porting muscle memory.
3. **Port on touch.** When an old spec needs editing anyway, port it —
   the mapping is mechanical by design (same locator/matcher names).
4. **Sunset.** When the old suite stops earning its CI minutes, delete it
   along with its config. Migrating should mean *deleting* configuration,
   not porting it.

A `e2e migrate` codemod for mechanical spec conversion is roadmap.

Deliberate side effect of API compatibility: models trained on Playwright
and Testing Library emit near-valid e2e code out of the box — familiarity
is also AI-legibility.

Status: ✅ v0 · P1 (fast follow) · P2 (later) · ✖ deliberate no.

## Playwright → e2e

| Playwright | e2e | Status |
|---|---|---|
| `page.goto/reload/goBack/goForward` | `web.goto/reload/back/forward` (portable: `app.open`) | ✅ |
| `page.url()` / `waitForURL` | `web.url()` / `web.waitForURL` | ✅ |
| `page.getByRole/Label/Placeholder/Text/TestId` | `screen.getBy*` (cross-platform) | ✅ |
| `page.getByAltText/Title` | folded into `getByLabel`/`getByText` (RNTL precedent) | ✖ |
| `page.locator(css/xpath)` | `web.locator(css)` | ✅ |
| `locator.filter({ hasText, has })` / `first/last/nth` | same | ✅ |
| `click/dblclick/fill/clear/press/check/uncheck/selectOption/focus/hover/dragTo` | `Locator` — same names (`tap` alias; `hover` P1, web-only via `web`) | ✅ / P1 |
| `setInputFiles` | `files` resource (roadmap) + agent, or `web` | P1 |
| `textContent/inputValue/getAttribute/isVisible/isEnabled/isChecked/boundingBox` | `Locator` — same names | ✅ |
| web-first `expect(locator)` matchers | `expect(locator)` (semantic set; no `toHaveClass/Attribute/Style`) | ✅ / ✖ |
| `expect(page).toHaveURL/toHaveTitle` | `expect(web).toHaveURL/toHaveTitle` | ✅ |
| `page.route/unroute` / `waitForResponse` | `web.route/unroute/waitForResponse` | ✅ |
| `context.cookies/addCookies` | `web.cookies/setCookies` | ✅ |
| `storageState` (auth reuse) | `session.save()` / `test.setup()` — better: cross-platform | ✅ |
| `page.evaluate` | `web.evaluate` | ✅ |
| dialogs (`page.on('dialog')`) | `web.onDialog` | ✅ |
| downloads | `web.waitForDownload` | ✅ |
| `keyboard`/`mouse` raw | `web.keyboard`/`web.mouse` | ✅ |
| `frameLocator` | `web.frameLocator` (queries only) | ✅ |
| viewport / device emulation | target `viewport`; `web.setViewport` | ✅ |
| multi-tab / popups (`context.waitForEvent('page')`) | — | P1 |
| `page.screenshot` | `app.screenshot` (evidence) | ✅ |
| trace viewer / HTML report | HTML step-timeline report (`e2e open` UI post-v0) | ✅ (Phase 2) |
| projects | `targets` | ✅ |
| fixtures (`test.extend`) | `test.extend` (reserved) | P1 |
| `test.step` | not needed: steps are derived from calls (self-labeling); grouping marker is roadmap | ✅ |
| retries / serial / tags | `retries`, `{ serial: true }`, `tags` | ✅ |
| `--shard` | `--shard` (post-v0) | P1 |
| `webServer` | `app.command` | ✅ |
| clock API | — | P2 |
| HAR record/replay | — | P2 |
| `toMatchScreenshot` visual diff | — (roadmap; `agent.assert` covers semantic checks) | P2 |
| component testing | — | ✖ (workflows only) |

## Maestro → e2e

| Maestro | e2e | Status |
|---|---|---|
| `launchApp` / `stopApp` | `app.open()` / `app.restart()` | ✅ |
| `launchApp: clearState` | `app.clearState()` (explicitly ≠ `restart()`) | ✅ |
| `openLink` | `app.deepLink()` | ✅ |
| `tapOn` (text/id) | `screen.getByText/TestId(…).tap()` or `agent.tap('…')` | ✅ |
| `tapOn: point` | — (agent handles; raw coords are driver-internal) | ✖ |
| `doubleTapOn` / `longPressOn` | `locator.doubleTap()` / `longPress()` | ✅ |
| `inputText` / `eraseText` | `locator.fill()` / `clear()` | ✅ |
| `hideKeyboard` | `device.hideKeyboard()` | ✅ |
| `swipe` | `screen.swipe({ direction, momentum })` / `locator.swipe()` | ✅ |
| `scroll` / `scrollUntilVisible` | `screen.scrollUntilVisible(locator)`; agent: `agent.scrollTo('…')` | ✅ |
| `back` | `app.back()` | ✅ |
| `assertVisible/assertNotVisible` | `expect(locator).toBeVisible()/.not.toBeVisible()` | ✅ |
| `extendedWaitUntil` | `locator.waitFor()` / `agent.waitFor('…')` | ✅ |
| `copyTextFrom` | `locator.textContent()` (real variables — it's TypeScript) | ✅ |
| `runFlow` / conditionals / loops | plain TS functions/`if`/`for` | ✅ |
| `evalScript` | plain TS | ✅ |
| permissions | `device.setPermission()` | ✅ |
| location | `device.setLocation()` | ✅ |
| push notification (bolt-on) | `device.pushNotification()` | ✅ |
| `takeScreenshot` | `app.screenshot()` | ✅ |
| `startRecording` | `artifacts: ['video']` | ✅ |
| `addMedia` | — | P1 |
| airplane mode / `setAirplaneMode` | — | P2 |
| Maestro Studio (recorder) | — (non-goal: recorder-first; `e2e dev` is the loop) | ✖ |
| `waitForAnimationToEnd` | driver-internal (settle heuristics) | ✅ |

## What "taking the best of both" means

- **From Playwright**: locator model + auto-waiting, web-first assertions,
  network interception, projects/parallelism/sharding, trace-style
  artifacts, `webServer`.
- **From Maestro**: app-lifecycle primitives (`clearState`, `back`,
  `deepLink`), gesture vocabulary (`swipe`, `scrollUntilVisible`),
  permissions/location as one-liners, flow simplicity.
- **From neither (ours)**: one API across platforms, the agent tiers,
  natural-language targets with cached locations, resources
  (email/credentials in v0; webhooks/files/phone next), sessions that work
  on mobile too, the step ledger and QA-report failures.
