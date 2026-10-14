---
name: migrate-to-e2e
description: Moves an existing Playwright, Cypress, Selenium, Detox, or Maestro suite to e2e one slice at a time, with the old suite running beside the new one until each ported test is proven. Keeps a MIGRATION.md progress file so any later session resumes where the last stopped. Use for /migrate-to-e2e, "migrate our tests to e2e", "port these Maestro flows", or when a project has an e2e config and an older suite still running.
---

# Migrate a suite to e2e

A migration is never one change. Each session ports one slice, proves it,
and leaves both suites green: the old runner keeps every test it had, and
the new e2e tests pass beside it. A progress file, `MIGRATION.md`, records
what moved, what is left, and why, so the next session, yours or another
agent's, starts from it instead of from scratch. The user decides when an old test goes.

Two references do most of the work. Read them; do not restate them.

- The e2e skill for everything the runner does: `.agents/skills/e2e/SKILL.md`
  once `npx e2e init` or `npx skills add tester-army/e2e` ran, or
  `npx e2e guide <topic>` from the installed package. Topics named below
  (`setup`, `writing-tests`, `agent`, `mcp`, `running`, `debugging`) are its
  reference files.
- The migration guide for the source runner, and the engine page it ports
  to. The guide maps the runner's config, commands, and API to e2e, and
  says what e2e does not have yet (marked `missing` or "No equivalent")
  with today's workaround. Both ship in the installed package under
  `node_modules/e2e/docs/` with the same paths as `.mdx` files.

Detect the source runner, then read both docs in its row in full, before
the inventory and before writing any code. Each later step leans on them.

| Source | Detect it by | Migration guide | Engine |
| --- | --- | --- | --- |
| Playwright | `playwright.config.*`, `@playwright/test` | [migrate/playwright](https://e2e.tester.army/docs/migrate/playwright.md) | [web](https://e2e.tester.army/docs/web.md) |
| Cypress | `cypress.config.*`, a `cypress/` folder | [migrate/cypress](https://e2e.tester.army/docs/migrate/cypress.md) | [web](https://e2e.tester.army/docs/web.md) |
| Selenium | `selenium-webdriver`, Selenium in a `pom.xml`, `build.gradle`, or `requirements.txt` | [migrate/selenium](https://e2e.tester.army/docs/migrate/selenium.md) | [web](https://e2e.tester.army/docs/web.md) |
| Detox | `.detoxrc*`, `detox` in `package.json` | [migrate/detox](https://e2e.tester.army/docs/migrate/detox.md) | [mobile](https://e2e.tester.army/docs/mobile.md) |
| Maestro | YAML flows opening with `appId:` and `---`, `.maestro/`, `maestro test` in a script or workflow | [migrate/maestro](https://e2e.tester.army/docs/migrate/maestro.md) | [mobile](https://e2e.tester.army/docs/mobile.md) |

WebdriverIO and Appium have no guide. Map their WebDriver calls with the
Selenium guide; map Appium's device commands with the Detox and Maestro
guides, on the mobile engine. Tell the user the mapping is partial. A
project with two source runners migrates one at a time, one section of the
progress file each.

## 1. Resume or start

Look for `MIGRATION.md` beside the e2e config, then at the repo root. When
one exists, this is a later session:

1. Read it, then the migration guide and engine page its `Source` line
   names. Its `Next` section names the slice this session takes, unless the
   user names another.
2. Check it against the repo before trusting it: every `ported` test still
   exists in both suites, every source file or test it lists still exists
   (except `retired` ones, deleted on purpose), and no new source file or
   test is missing from it (add those as `todo`).
3. Run the file's `Run new` command once. A ported test that fails now is
   the first thing to fix, before any new slice.
4. Unless the progress file's `Harness:` line says `done`, go to step 3, Build
   the harness. Otherwise go to step 4, Pick the slice.

No progress file means a first session: steps 2 and 3, then the rest.

## 2. Inventory the suite (first session)

Answer these from the repo; ask the user only what you cannot observe.

| Question | Where the answer is | What it decides |
| --- | --- | --- |
| Source runner | The detection table above | The two docs read before this table |
| Tests | Every spec, flow, or test file, with its titles, tags, and per-platform or per-browser branches. Count tests with the runner's own list or dry-run mode, not by grepping, which misses tests made in a loop. `npx playwright test --list` prints a test once for every project that runs it, so count a test listed under several projects once | The progress file's rows, one per source file. Count each file's assertions now so a port can be checked against the count: explicit ones (`expect`, `should`, `assertVisible`), plus, where the runner's steps are its checks (a Maestro `tapOn` fails when its target is missing), those steps |
| Shared code | Page objects, custom commands, subflows (`runFlow: file.yaml`), fixtures, hooks, `globalSetup` | Helpers to port once, before the first test that needs each |
| How it runs | The CI job that runs the suite and the scripts it calls: the build, the services and mock servers it starts, seed and reset calls, env files, devices or browsers, ports | The e2e harness. The CI job is usually the only complete description; read it line by line |
| Where e2e lives | A JavaScript or TypeScript project with a `package.json`: its root (in a monorepo, beside the source runner's config), tests in `tests/**/*.e2e.ts`. A native, Java, or Python project: an `e2e/` folder with its own `package.json` beside the app. Then the source runner's file pattern (`testDir`, `testMatch`, `specPattern`, the flow folder) | The e2e config's location and the progress file's. The two runners must not collect each other's files: when the patterns overlap, narrow one of them. Playwright suites often name files `*.e2e.ts` already, which leaves the directories as the only separation: no e2e test under a Playwright `testDir`, and no Playwright file under e2e's `tests` glob. Compare `npx playwright test --list` with `npx e2e list` |
| Can the old suite run here | The source runner installed, the build it needs, the services | Whether parity is checked against a live old run (step 6) or only against the source text |

Write `MIGRATION.md` now (format in step 8), every source file `todo`.

## 3. Build the harness (once)

The harness is the config, the app launch, and one green test. It is done
once and the progress file says so; later sessions skip this step.

1. No e2e config: `npx e2e init --yes` (topic `setup`). On a device project, swap
   `@e2e-dev/web` for `@e2e-dev/mobile` and delete or rewrite the example
   test. One target per platform or browser the source suite covers.
2. Ask the user which model agent steps use, and configure it (topic
   `agent`). A literal port needs none: every test can be deterministic, and
   a config without a model runs those.
3. Port the orchestration the CI job does, reusing the repo's own scripts
   rather than writing new ones:
   - The one process that serves the app (a dev server, Metro for an Expo dev
     client) becomes the target's `app.command` with `readyUrl` (topic
     `setup`). The command gets only `PATH`, `HOME`, the temp-directory
     variables, and `command.env`, not the shell's environment, so pass
     what the server read from the old runner's environment in
     `command.env`.
   - e2e has no `services` key. Databases, queues, and mock servers start
     before the run with the command the CI job uses, or `app.command` runs
     a script that brings them up and then serves the app. Name the command
     in the progress file.
   - A reset or seed the source ran per test (`runScript` with `http.post`,
     `cy.task('db:reset')`, an API call in `beforeEach`) becomes `fetch` in a
     `beforeEach` or a fixture, so each test still starts from known data.
   - A seed helper that imports the app's own code (an ORM factory, a
     server module) is reused, not rewritten. The old runner may have
     compiled it to CommonJS; e2e loads every `.ts` file as an ES module.
     Importing it into a test can then fail with `__dirname is not
     defined`, with "does not provide an export named" for a CommonJS
     package, or with `ERR_UNSUPPORTED_DIR_IMPORT`. When it does, run the
     helper unchanged in a child process with the repo's own TypeScript
     runner (`ts-node`, `tsx`) and call it from a fixture. Do not edit the
     app's modules to make them load.
   - Env values become module constants; passwords and tokens go under
     `credentials` or `secrets` (topic `setup`). When the old config loaded
     an env file (`dotenv.config()`), load it the same way in the e2e
     config, so tests and helpers see the same values. `app.command` does
     not see them; pass the ones the server needs in `command.env`.
4. Port the simplest source test, often the sign-in or the launch, as the
   smoke test. It must pass on every target before any other port. When it
   cannot, the harness is wrong, not the test: fix the harness.
5. `init` adds a `test:e2e` script (`e2e run`) unless a script already has
   that name. When the name was taken, or `init` did not run, add one under
   a free name. Keep the old suite's scripts as they were.
6. Mark the harness done in the progress file, with the commands that start the
   dependencies, run the old suite, and run the new one.

## 4. Pick the slice

A slice is what this session can finish green: one file, one folder, one
tag, or one feature area, usually one to five tests. Ask the user which.
When they leave it to you, suggest in this order:

1. Tests whose shared helpers are already ported.
2. Tests that break often in the old runner: retries, flaky history in CI,
   comments explaining a workaround for the runner. They gain the most.
3. Tests that need a capability the guide marks `missing` or "No
   equivalent", last.

Write the slice into the progress file's `Next` section before starting, so an
interrupted session leaves a trail.

## 5. Port the slice

Port the slice's shared helpers first, once, as plain `.ts` files (not
`.e2e.ts`, so the runner does not collect them), for example under
`tests/support/`. A subflow
becomes a function or a `test.extend` fixture; a page object becomes a
fixture (topic `writing-tests`). Record each in the progress file.

Then each test, one at a time:

- Keep its title, and open the file with a comment naming the source
  (`// Ported from __e2e__/flows/login.yml`), so reports and reviewers map
  one to the other.
- Translate literally first with the guide's tables, one awaited call per
  source step. Each source assertion maps to its own e2e assertion. A wait
  that fails on timeout (`waitForFunction`) becomes one more, so the e2e
  count is at least the inventory's.
- A test the source skips is ported in full and stays skipped, with the
  source's reason, so it can be turned back on in either suite. Its row
  says so; when the reason allows, run it unskipped once and note the
  result.
- Learn exact names before writing a locator: `e2e mcp` with `open_session`,
  `observe`, and `locate` (topic `mcp`). When your client has no `e2e` MCP
  tools, run the test and read the screen listed on its trace page
  (topic `debugging`); do not build a bridge. The guide's notes on
  selectors list the edits most ports need: e2e matches whole strings and
  fails on several matches where the old runner took the first. When a
  query also matches a hidden copy (another layout's), add
  `{ visible: true }`. When two visible nodes match, such as a second
  toast over the first, pick the one the step means.
- A sleep or fixed wait becomes an assertion on the state it waited for.
- A per-platform branch becomes `{ platforms: [...] }` on a test, or an `if`
  on the `platform` fixture inside one.
- A workaround the source comments explain (a flaky `hideKeyboard`, a
  coordinate tap, a retry loop around a picker) is a workaround for the old
  runner. Try the plain step first; keep a workaround only when e2e needs it
  too, with its own comment saying why.
- Where the guide marks a step `missing` or "No equivalent", use its
  workaround. When there is none, the test stays in the old runner: mark it
  `stays` with the reason and send
  `npx e2e feedback --type feature -m "<the gap>"` once (the e2e skill,
  Feedback).
- Do not change app code. A test that needs a test id the app lacks gets
  `agent.act` or a different locator; propose the app change to the user
  instead of making it.

`agent.act` comes after the literal port passes, never instead of it, and
only with a model configured. Propose it for a stretch the source kept
patching: coordinate taps, picker spins, long tap sequences through a
wizard. Pin the outcome right after with a locator assertion (topic `agent`).

## 6. Prove each port

A port is done when it is as strict as the source and passes every time.

1. Run it on every target the source covered:
   `npx e2e run <file> --repeat-each 3`, plus `--no-cache` when it has agent
   steps. Three of three on each target, or it is not done (topic
   `running`).
2. When the old suite can run here, run the source test on the same build.
   A failure both runners show is an app or environment bug: report it, do
   not port around it. A failure only e2e shows is the port's.
3. Check strictness against the source: an e2e assertion for every source
   assertion, so the count is at least the inventory's, and every end
   state the source checked is checked. Never
   weaken an assertion, widen a timeout without a reason, or drop a step to
   go green. A test that cannot pass honestly stays `blocked` with what
   failed.
4. Read the trace page of any failure before changing the test
   (topic `debugging`).

## 7. Run both suites

Until the user retires a source test, both runners keep it.

- Ported tests stay in the old suite too. Delete a source test only when the
  user confirms, then mark it `retired`. Once neither a remaining source
  test nor e2e code uses a source helper, propose deleting it, and delete
  it when the user confirms.
- CI: propose adding the e2e suite beside the old job once a few ports are
  green, and make the change only when the user agrees, since it edits the
  old runner's workflow. Reuse its build, services, and devices. Two
  runners never drive one device or simulator at the same time; run them one after the other in the same job, or give each its own
  device. The e2e job runs every ported test, so a later change that breaks
  one fails the pull request (topic `running`, Continuous integration).
- When the last source test is retired or marked `stays`, the progress file says
  the migration is complete and which tests, if any, stay behind.

## 8. Keep the progress file

`MIGRATION.md`, beside the e2e config, is the migration's state. Update it
as you go, not at the end; an interrupted session must leave it true.

```md
# Migration to e2e

Source: Maestro, `__e2e__/flows/**` (guide: https://e2e.tester.army/docs/migrate/maestro.md, engine: https://e2e.tester.army/docs/mobile.md)
e2e: `e2e.config.ts`, tests `tests/**/*.e2e.ts`
Start dependencies: `pnpm e2e:mock-server`
Run old: `maestro test __e2e__`
Run new: `npx e2e run`
Harness: done, smoke `tests/login.e2e.ts` on ios and android

| Source | e2e | Status | Assertions (source → e2e) | Passing | Notes |
| --- | --- | --- | --- | --- | --- |
| flows/login.yml | tests/login.e2e.ts | ported | 3 → 3 | ios 3/3, android 3/3 | |
| flows/create-account.yml | | blocked | 6 → | | date picker spin fails on android, trace in .e2e/results |
| flows/search-screen.yml | | todo | 4 → | | |

## Shared helpers

| Source | e2e | Used by |
| --- | --- | --- |
| setupApp.yml | tests/support/app.ts `openSignedOut()` | login, create-account |

## Gaps

- `addMedia` has no e2e equivalent (guide: missing); feedback sent.

## Next

flows/composer.yml and flows/composer-self-label.yml (both need `signInAlice()`).
```

One row per source file. A file whose tests end in different statuses
gets one row per test, each with its own assertion count. A suite with
hundreds of tests keeps file rows: the table is read at the start of
every session.

Statuses: `todo`; `ported` (green in e2e, the source test still runs);
`retired` (the user confirmed, the source test is deleted); `blocked`
(tried, does not pass yet, with what failed); `stays` (stays in the old
runner on purpose, with why).

## 9. Hand over

Tell the user what this session moved and what it proved: the tests ported
and their pass counts per target, the helpers ported, what is blocked or
stays and why, the gaps reported, and the next slice. Ask which `ported`
source tests may be retired. List every file you created or changed.

## Rules

- One slice per session. Leave both suites green: the old suite passes as it
  did, and every `ported` test passes.
- Never delete or edit a source test, helper, or the old runner's config
  without the user's confirmation.
- Port from what the repo shows. Run every command you put in the
  progress file at least once; one that cannot run here (the old runner not installed) says
  so in the progress file.
- A source step whose meaning is unclear, such as a tap on a disabled
  control or a coordinate tap that may miss, keeps its intent in the port.
  Note your reading in the progress file and ask the user.
- One sentence from the e2e skill or the guide beats a paragraph of your
  own. Name the topic or the guide's section.
- Never put a secret in a test, the config, or the progress file. Name the
  credential (topic `setup`).
- Do not commit on the user's behalf.
