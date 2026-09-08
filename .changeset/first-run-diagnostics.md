---
'@e2edev/e2e': minor
---

The first run of a new project fails with a sentence that names the fix, not a
symptom. Walking through everything a first-time user does wrong:

- `e2e init` without a terminal (a CI step, a pipe) used to wait forever on a
  prompt nobody could answer; it now exits 2 and names `--yes`. `e2e init
  <directory>` scaffolds into that directory, creating it when missing, and the
  `next:` line starts with `cd`. An invalid `package.json` quotes the parser's
  position or the field with the wrong shape.
- A Node.js older than 22.12 is told so, with both versions, before anything
  else loads.
- `e2e run` with no config file is `CONFIG_NOT_FOUND` naming the directory
  searched and `e2e init`, and calls out `e2e.config.js` (or another
  look-alike) when that is what exists, instead of `targets is required`.
- A failing import in the config or a test file says what to do: a declared
  but uninstalled package ends with `run pnpm install` (or the project's
  package manager), an undeclared one with the add command, a wrong subpath
  with the subpaths the package exports, `defineConfig` with its replacement,
  and a misspelled export with the nearest one.
- `NO_TESTS` says why: no file matched the `tests` globs (naming
  `tests/login.test.ts` and other look-alikes beneath the globbed directories),
  a positional matched nothing (with the nearest discovered file), a file
  registered no tests (its `test` is imported from elsewhere), or every test
  was filtered, skipped, or is a setup test.
- Unknown config, target, agent, cache, limits, and artifacts keys, unknown
  `--target` IDs and reporters, and unknown fixtures all suggest the nearest
  valid name. Keys from other runners (`testDir`, `baseURL`, `webServer`,
  `use`, `projects`, a `url` on a target) point at where that fact lives here;
  `page`, `browser`, `context`, `request`, and `driver` fixtures are explained
  in terms of `app`, `screen`, and `web`. Durations name their unit and quote
  the value: `timeout must be a positive safe integer of milliseconds, got "30s"`.
- A test failure carries its `cause` chain, so the scaffold's HTTP check fails
  with `fetch failed: connect ECONNREFUSED 127.0.0.1:3000` rather than `fetch
  failed`. `app.open()` against an address where nothing listens is
  `APP_UNREACHABLE` with the URL and the three ways to fix it, not an engine
  failure. A target without an engine says so when `screen` or `agent` is
  used, and names the two first-party engines.
- A rejected model credential names the variable it was read from
  (`E2E_MODEL_API_KEY`, `AI_GATEWAY_API_KEY`, or the configured `apiKeyEnv`)
  rather than the gateway's own default, and ANSI color codes in provider
  messages no longer reach the report or the terminal.
