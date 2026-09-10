# Debugging a failing run

## Read the failure

1. The `list` reporter ends with a `Failed Tests` section: each failure shows
   the error code, the message, the test's failing line, and a code frame.
   The summary's `Report` line names `.e2e/report.json`.
2. `.e2e/report.json` has everything:

```bash
jq '.run | {status, exitCode, errors}' .e2e/report.json                  # run-level failures
jq '.run.results[] | select(.status != "passed") | {titlePath, file, status}' .e2e/report.json
jq '.run.results[] | select(.status != "passed") | .attempts[-1]
    | {status, error, steps: [.steps[] | select(.status != "passed") | {api, label, status, error}], artifacts}' .e2e/report.json
```

3. Artifacts named there live under `.e2e/artifacts/`: screenshots, a
   Playwright `trace.zip` per attempt (`npx playwright show-trace <file>`),
   downloads, with `--video` a `video/video.webm` per attempt, and with
   `--debug` the transcript of every agent step.

## Error codes and what to do

| Code | Usual cause | Fix |
| --- | --- | --- |
| `CONFIG_LOAD_FAILED` mentioning ES modules | `package.json` lacks `"type": "module"` | `npm pkg set type=module`, or rename the config to `.mts` and keep the tests in an ESM package |
| `INVALID_CONFIG` | Unknown key or a stale shape: a top-level `app`, `defineConfig`, a `backend` key, `json` combined with `list` reporters | Move app options into `playwright({ ... })`; use `satisfies E2EConfig`; the message names the key |
| `CONFIG_NOT_FOUND`, `CONFIG_AMBIGUOUS` | Wrong `--config` path; both `.ts` and `.mts` present | Fix the path; keep one config file |
| `NO_TESTS` | The glob or a positional matched nothing | The message names each positional that matched nothing. Check `tests` in the config and the `.e2e.ts` suffix |
| `COLLECTION_ERROR` | `async` describe body, `test.setup` inside `describe`, an option forbidden in a serial group, registration outside collection | Rework the structure per `writing-tests` |
| `APP_UNREACHABLE` | `command` never answered `readyUrl` within `startupTimeout`; a service exited non-zero | Set `command.log` and read it; check the port and `url`; pass the env the app needs through `command.env`; raise `startupTimeout` |
| `APP_ALREADY_RUNNING` | Something already serves `url` when the runner wanted to start `command` | Stop it, or set `reuseExisting: true` for local runs |
| `APP_URL_REQUIRED` | A navigation on an engine without `url` | Add `url` to `playwright({ ... })` |
| `LOCATOR_NOT_FOUND` | Wrong role or name, text not exact, element off screen or inside an iframe, page not open | Read the markup for the accessible name; try `exact: false` or a RegExp; `web.frameLocator` for iframes; `app.open()` first; `--headed` to look |
| `LOCATOR_AMBIGUOUS` | Two matches: a hidden duplicate, a repeated label | Add `{ name }`, scope under a container, `filter`, `first()`, or `{ visible: true }` |
| `ASSERTION_FAILED` | The expectation is wrong, or the state settles later than 5 s; for `agent.assert`, the judgment was false (explanation in the report) | Compare with the actual text in the report or screenshot; `{ timeout }` on the matcher; rewrite the question |
| `ACTION_FAILED` | Element not actionable (covered, disabled, detached) or an operation timed out | Wait on the right condition with `expect` first; close overlays; check `actionTimeout` |
| `TEST_TIMEOUT` | The attempt exceeded `timeout` (120 s) | Split the test, or raise `timeout` for slow flows and agent steps |
| `MODEL_UNAVAILABLE` | No model (`createAgent({ model })`, `agent.model`, or `E2E_MODEL`), no key, or an unknown provider. Reported once for the run under `run.errors`; the run stops | Export `E2E_MODEL=provider/model-id` and `E2E_MODEL_API_KEY`, or pass a model to `createAgent`; confirm the model id |
| `MODEL_PROVIDER_FAILED` | Network, 5xx, rate limit, or no credits after the transport retries | Check the key and the quota; retry; exit code 3 |
| `STEP_TIMEOUT`, `STEP_BUDGET_EXHAUSTED` | The goal was too big or ambiguous, or the provider slow | Split the goal, use on-screen wording, add `context`, raise `timeout` and `actionTimeout`, `--debug` to read the transcript |
| `CONTEXT_OVERFLOW` | The screen plus the step's history did not fit the model's context window, even after the loop shrank the history and retried once | Lower `agent.maxObservationBytes`, split the step, or pick a model with a larger window |
| `POLICY_DENIED` | Navigation outside `allowedOrigins`; a `Secret` given to a sink that is not a password field; reading a secure field | Add the origin to `allowedOrigins`; fill secrets only into password inputs; assert the outcome instead of the value |
| `UNSUPPORTED_CAPABILITY` | A fixture the engine does not contribute (`web` on a device), `schema` or `vision` on `act`, an action the surface lacks | Declare `requires: ['web']`; drop the option; use a supported action |
| `SESSION_UNAVAILABLE`, `SESSION_CONTRACT` | `session: 'x'` with no setup saving `x`; a setup that did not save every declared name | Add or fix the `test.setup` |
| `ONLY_IN_CI` | `test.only` reached CI | Remove it |
| `BROWSER_INSTALL_FAILED`, `LAUNCH_TIMEOUT` | Browser download or launch failed | `npx playwright install chromium --with-deps`; raise `launchTimeout` on slow machines |
| `AUTH_CREDENTIAL_UNAVAILABLE` | `credentials.user('x')` for an undeclared name | Add it to `config.credentials` |

## Tools

| Do | When |
| --- | --- |
| `--headed` | Watch the flow; confirm what the page shows at the failing step |
| `--workers 1 --retries 0` | Remove parallelism and retries from the picture |
| `--no-cache` | Rule out a stale `agent.act` replay |
| `--debug` | Read each agent step's duration, model calls, cost, and transcript |
| `--ai-trace`, then `npx unbox-ai runs .e2e/ai-trace.json` | See exactly what the model was shown and called |
| `--video` | Watch the failed attempt; `step.startedAt` minus the video artifact's `startedAt` is the step's offset into it |
| `command.log: '.e2e/logs/app.log'` | Read the app's own output when it never becomes ready or errors mid-test |
| `await app.screenshot('before-submit')` | Attach evidence at a chosen point |
| `CI=1 npx --no-install e2e run` | Reproduce CI-only behaviour: `ONLY_IN_CI`, read-only cache, `reuseExisting` ignored |

## Flaky tests

- A read (`textContent()`, `count()`) captured a value mid-update: replace
  it with a matcher.
- Shared data between tests: unique names per run, cleanup in `afterEach`,
  or a `serial` group.
- The app is not ready: assert on the element you are about to use rather
  than on the previous page.
- An agent judgment asserts an exact phrasing: judge the fact, and add a
  deterministic `expect` beside it.
- Timing under load: `retries` masks the cause; `--workers 1` and
  `--headed` usually show it.

## Is it the app?

A deterministic step that fails every run at the same place with the same
code is a product bug or a changed screen, not flakiness. Reproduce once
with `--headed`, then fix the app, or update the locator and the expectation
together. A blocked agent step (`AUTH_CREDENTIAL_UNAVAILABLE`,
`ENVIRONMENT_UNAVAILABLE`, `SEED_DATA_MISSING`) exits 2 or 3 on purpose: fix
the environment, not the test.
