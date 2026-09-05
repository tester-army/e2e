# 12 - Migration Coverage

This is an informative adoption map, not a claim of full API parity. e2e
intentionally standardizes a portable semantic subset and documents every
known migration gap. Normative behavior lives in the numbered API/profile
documents and canonical declarations.

Status: `v0` ships in the web profile, `future mobile` requires unassigned mobile profiles,
`later` is unscheduled, and `no` is deliberately excluded.

## Adoption

Existing suites can run beside `tests/**/*.e2e.ts`. Teams can write new tests
first, port touched flows, and remove the old runner only when the documented
subset covers their needs. Backend reuse does not make unsupported Playwright
objects or semantics implicitly available.

## Playwright to e2e

| Playwright | e2e | Status |
|---|---|---|
| `page.goto/reload/goBack/goForward` | `web.goto/reload/back/forward` | v0 |
| `page.url` / `waitForURL` | `web.url` / `web.waitForURL` | v0 |
| role/label/placeholder/text/testId queries | `screen.getBy*` | v0 |
| `getByAltText` / `getByTitle` | use role/name or text where equivalent | no direct API |
| CSS/XPath locators | `web.locator`, explicit `xpath=` | v0 |
| locator filters and first/last/nth | same concepts | v0 |
| click/double-click/fill/clear/press/check/select/focus/drag | `Locator` | v0 |
| hover | web capability addition | later |
| input files | file-resource/web addition | later |
| locator reads | normalized `Locator` reads | v0 |
| semantic locator assertions | `expect(locator)` | v0 |
| class/attribute/style assertions | intentionally implementation-facing | no |
| URL/title assertions | `expect(web)` | v0 |
| route/unroute/waitForResponse | `web` | v0 |
| cookies | `web.cookies/setCookies` | v0 |
| storage state | setup tests plus per-run sessions | v0 |
| `page.evaluate` | constrained `web.evaluate` | v0 |
| dialogs | attempt-scoped `web.onDialog` | v0 |
| downloads | contained `web.waitForDownload` | v0 |
| keyboard/mouse | `web.keyboard/mouse` | v0 |
| frame locator | query-only `web.frameLocator` | v0 |
| viewport | target viewport / `web.setViewport` | v0 |
| multi-page contexts/popups | no v0 equivalent | later |
| screenshots | redacted `app.screenshot` | v0 |
| element screenshots | crop artifact | later |
| traces/video/HTML report | driver artifacts plus `report-1` | v0 |
| projects | named targets | v0 |
| custom fixtures | `test.extend` | later |
| `test.step` | derived steps; grouping marker if needed | no direct API |
| retries/serial/tags | runner options | v0 |
| sharding | planned runner capability | later |
| web server | structured `command` on the backend's app declaration | v0 |
| clock/HAR/visual diff | dedicated future profiles | later |
| component testing | workflows only | no |

## Maestro to e2e

The following mappings are design targets for future mobile profiles. Their presence does
not make a v0 web runner mobile-conformant.

| Maestro | Reserved e2e shape | Status |
|---|---|---|
| launch/stop/clear state | `app.open/restart/clearState` | future mobile |
| open link | `app.deepLink` | future mobile |
| text/id tap | `screen` locator or `agent.act` | future mobile |
| raw point tap | intentionally driver-internal | no |
| double tap/long press | `Locator` actions | future mobile |
| input/erase text | `fill/clear` | future mobile |
| hide keyboard | `device.hideKeyboard` | future mobile |
| swipe/scroll | `screen` and locator gestures | future mobile |
| back | `app.back` | future mobile |
| visible/not visible | locator assertions | future mobile |
| extended wait | locator/agent waits | future mobile |
| copy text | locator reads and TypeScript variables | future mobile |
| flows/conditionals/loops | TypeScript | future mobile |
| permissions/location/push | `device` capability | future mobile |
| screenshot/video | driver artifacts | future mobile |
| media injection/airplane mode | undecided | later |
| recorder/studio | recorder-first workflow is a non-goal | no |
| animation settling | profile-defined actionability | future mobile |

## Deliberate differences

- e2e owns runner polling, cardinality, policy, reports, and retries; it does
  not inherit every backend default.
- Backend objects never appear in tests.
- Sessions isolate client state, not application databases.
- Agent path guidance remains model-assisted and is not deterministic replay.
- Credentials are the only v0 resource; email, files, webhooks, and phone are
  extensions after v0.
