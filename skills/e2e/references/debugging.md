# Debugging a failing run

## Read the failure

1. Run with `--reporter list,markdown`. The `list` reporter ends with a
   `Failed Tests` section: the error code, the message, the failing line with
   a code frame, the page's location, the nodes closest to what a failed
   locator asked for, and the path of the screen text. The summary's
   `Failures` line names `.e2e/failures/`.
2. Open the failed test's page under `.e2e/failures/` first. It has the error
   in full, its facts (`Expected … · Observed …` for an `expect`, `Asked for:
   button "Add" · waited 3.0s` for a locator), `Look at:` the line the failure
   unwound through, whether every attempt failed the same way (a bug, not a
   flake), every step with its own line, the last model turns of a failed
   agent step, and the screen at failure inline: the accessibility tree as
   the agent reads it, one node per line. Write the fix from what was there.
3. `.e2e/report.json` is the record behind the pages:

```bash
jq '.run | {status, exitCode, errors}' .e2e/report.json                  # run-level failures
jq '.run.results[] | select(.status != "passed") | {titlePath, file, status}' .e2e/report.json
jq '.run.results[] | select(.status != "passed") | .attempts[-1]
    | {status, error, failure, steps: [.steps[] | select(.status != "passed") | {api, label, source, status, error}], artifacts}' .e2e/report.json
```

   `error.details` holds the facts, `error.source` the line, `failure` the
   `url`, the `screen` and `screenshot` artifact ids, and the `candidates`;
   a failed agent step has `turns`.
4. Artifacts named there live under `.e2e/artifacts/`: `failure/screen.txt`
   and the engine's failure screenshot per failed attempt, a Playwright
   `trace.zip` per attempt (`npx playwright show-trace <file>`), downloads,
   with `--video` a `video/video.webm` per attempt, and with `--debug` the
   full transcript of every agent step.

## Error codes and what to do

| Code | Usual cause | Fix |
| --- | --- | --- |
| `CONFIG_LOAD_FAILED` | The config throws while loading, or imports a package that is not installed or a subpath that does not exist | The message names the cause: install the dependency, or fix the import it quotes |
| `INVALID_CONFIG` | Unknown key or a stale shape: a top-level `app`, `defineConfig`, a `backend` key, `json` combined with `list` reporters | Move app options into `web({ ... })`; use `satisfies E2EConfig`; the message names the key |
| `CONFIG_NOT_FOUND`, `CONFIG_AMBIGUOUS` | Wrong `--config` path; both `.ts` and `.mts` present | Fix the path; keep one config file |
| `NO_TESTS` | The glob or a positional matched nothing, or a filter left nothing to run | The message names each positional that matched nothing and, under `--tag`, each tag no test declares with the nearest declared one. Check `tests` in the config, the `.e2e.ts` suffix, and the tag names |
| `NO_LAST_RUN` | `--last-failed` found no `.e2e/report.json` to read | Run once without the flag; the rerun reads the report that run writes |
| `COLLECTION_ERROR` | `async` describe body, `test.setup` inside `describe`, an option forbidden in a serial group, registration outside collection | Rework the structure per `writing-tests` |
| `APP_UNREACHABLE` | `command` never answered `readyUrl` within `startupTimeout`; a service exited non-zero | Read the last log lines quoted under the error; set `command.log` if it says to; check the port and `url`; pass the env the app needs through `command.env`; raise `startupTimeout` |
| `APP_ALREADY_RUNNING` | Something already serves `url` when the runner wanted to start `command` | Stop it, or set `reuseExisting: true` for local runs |
| `APP_URL_REQUIRED` | A navigation on an engine without `url` | Add `url` to `web({ ... })` |
| `LOCATOR_NOT_FOUND` | Wrong role or name, text not exact, element off screen or inside an iframe, page not open | Read the markup for the accessible name; try `exact: false` or a RegExp; `web.frameLocator` for iframes; `app.open()` first; `--headed` to look |
| `LOCATOR_AMBIGUOUS` | Two matches: a hidden duplicate, a repeated label | Add `{ name }`, scope under a container, `filter`, `first()`, or `{ visible: true }` |
| `ASSERTION_FAILED` | The expectation is wrong, or the state settles later than 5 s; for `agent.assert`, the judgment was false (explanation in the report) | Compare with the actual text in the report or screenshot; `{ timeout }` on the matcher; rewrite the question |
| `ASSERTION_INCONCLUSIVE` | `agent.assert` asked about something the screen does not show: another page, still loading, or only in pixels. A failure, never a pass | `app.open()` or `agent.waitFor` the right screen first; ask about what is visible; `vision: true` when the answer is in pixels |
| `ACTION_FAILED` | Element not actionable (covered, disabled, detached) or an operation timed out | Wait on the right condition with `expect` first; close overlays; check `actionTimeout` |
| `TEST_TIMEOUT` | The attempt exceeded `timeout` (120 s) | Split the test, or raise `timeout` for slow flows and agent steps |
| `STEP_NOT_AWAITED` | The body returned while a step was still running: a step call without `await` | Put `await` in front of the call the code frame names; every `app`, `agent`, `screen`, and `expect` call is awaited |
| `MODEL_UNAVAILABLE` | No model: neither `createAgent({ model })` nor `agent.model` holds an AI SDK instance. Reported once for the run under `run.errors`; the run stops | Construct one in the config, e.g. `gateway('openai/gpt-6-luna-fast')` from `ai`, and export the key its provider reads (`AI_GATEWAY_API_KEY`) |
| `MODEL_PROVIDER_FAILED` | Network, 5xx, rate limit, or no credits after the transport retries | Check the key and the quota; retry; exit code 3 |
| `STEP_TIMEOUT`, `STEP_BUDGET_EXHAUSTED` | The goal was too big or ambiguous, or the provider slow | Split the goal, use on-screen wording, add `context`, raise `timeout` and `actionTimeout`, `--debug` to read the transcript |
| `CONTEXT_OVERFLOW` | The screen plus the step's history did not fit the model's context window, even after the loop shrank the history and retried once | Lower `agent.maxObservationBytes`, split the step, or pick a model with a larger window |
| `POLICY_DENIED` | Navigation to a `file:`, `data:`, or `javascript:` URL; a password `Secret` given to a sink that is not a password field; reading a secure field; `app.screenshot()` after a secret fill | Open http(s) URLs only; fill passwords only into password inputs; assert the outcome instead of the value; capture screenshots before filling secrets |
| `UNSUPPORTED_CAPABILITY` | A fixture the engine does not contribute (`web` on a device), `schema` or `vision` on `act`, an action the surface lacks | Declare `requires: ['web']`; drop the option; use a supported action |
| `SESSION_UNAVAILABLE`, `SESSION_CONTRACT` | `session: 'x'` with no setup saving `x`; a setup that did not save every declared name | Add or fix the `test.setup` |
| `ONLY_IN_CI` | `test.only` reached CI | Remove it |
| `BROWSER_INSTALL_FAILED`, `LAUNCH_TIMEOUT` | Browser download or launch failed | `npx playwright install chromium --with-deps`; raise `launchTimeout` on slow machines |
| `AUTH_CREDENTIAL_UNAVAILABLE` | `credentials.user('x')` for an undeclared name | Add it to `config.credentials` |
| `SECRET_UNAVAILABLE` | `secrets.get('x')` for an undeclared name | Add it to `config.secrets` or set `E2E_SECRET_X` |

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
| `await app.screenshot('before-submit')` | Attach evidence before any secret is filled; later calls fail with `POLICY_DENIED` |
| `CI=1 npx e2e run` | Reproduce CI-only behaviour: `ONLY_IN_CI`, read-only cache, `reuseExisting` ignored |

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
