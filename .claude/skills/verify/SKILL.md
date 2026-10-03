---
name: verify
description: Prove a change to the e2e runner, an engine, the CLI, a reporter, the MCP server, or the docs works the way a user sees it - the real CLI against the testbed and benchmark apps, headed and on video when it matters, main against the branch for fixes. Use while iterating and before opening a PR, when asked to run, test, check, or screenshot something, to reproduce a bug report, or whenever you would otherwise say "it compiles".
---

# Verify

Every change ships with evidence from the real thing. Unit tests passing is
not evidence that the CLI prints the right line, a locator finds the node on
a real page, or an agent step replays. The testbed and the benchmarks are
the app here: they consume the **built** packages the way a user does. Use
this skill in the loop, not only at the end: change, build, run, look,
repeat.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm --filter @e2e-dev/web exec playwright-core install chromium
pnpm build                    # every consumer below runs dist; rebuild after each change
```

A stale `dist` is the most common false result. Rebuild before trusting any
run, and after switching branches.

## Pick the surface

| Change | Run | Proves |
| --- | --- | --- |
| Runner, collect, locator, config, sessions, CLI flags | the testbed suite, or the file covering it | The built CLI end to end on a deterministic app |
| Reporters (list, json, markdown, junit) | the testbed file plus `test:stress` | The printed and written output, hostile titles included |
| `@e2e-dev/web` | the testbed file, then the web benchmark's `tests/` | Real Chromium on plain and hard surfaces |
| Agent (`src/agent/`), prompts, trace cache | the web benchmark's `tests-agent/` replay, then `--no-cache --ai-trace` | Replay still hits, and the live agent still reaches the goal |
| `@e2e-dev/mobile` | the mobile benchmark on a simulator or emulator | Real devices; see `apps/mobile-benchmark` |
| `e2e mcp` | the `e2e` MCP server on the testbed | The tools as a coding agent sees them |
| `e2e init`, packaging, the skill | packed tarballs in a scratch project under `/tmp` | What a new user gets from npm |
| Docs pages | `pnpm docs:dev` | The rendered page |
| `@e2e-dev/github` | the PR's own `e2e-github` comments | The comment a user's PR gets |

Commands (run from the app directory; call the CLI directly, since
`pnpm run <script> -- --flag` forwards the `--` and the CLI reads the flag
as a file):

```bash
cd apps/testbed && node node_modules/e2e/dist/cli/bin.js run tests/todos.e2e.ts
cd apps/web-benchmark && pnpm run build     # the Next.js app, once per scenario change
cd apps/web-benchmark && node node_modules/e2e/dist/cli/bin.js run tests/<scenario>.e2e.ts
cd apps/web-benchmark && node node_modules/e2e/dist/cli/bin.js run --config e2e.agent.config.ts
pnpm test:testbed && pnpm test:web-benchmark          # the whole gate, as CI runs it
```

Add a deterministic test next to the behavior when it must stay proven: a
testbed page plus test for a runner feature, a benchmark scenario for a hard
surface (keep scenario diffs minimal, never fix a planted bug). Tests follow
[skills/e2e](../../../skills/e2e/SKILL.md), the consumer skill; this repo is
its first consumer.

Agentic runs need `AI_GATEWAY_API_KEY`. The benchmark agent suites replay
their committed recordings and call the model only for a step with none, as
CI does; a step that spends a model call there means its recording went
stale. Go live with `--no-cache --ai-trace` only when the change is to the agent, and
read the trace with [unbox-ai](../unbox-ai/SKILL.md) (`compare` main against
the branch), never by opening it. Re-recorded entries are committed in the
same PR ("Committed recordings" in `AGENTS.md`).

## The MCP server

`.mcp.json` registers `e2e mcp` on the testbed. `open_session`, then
`call {tool: "observe"}`, `locate`, `screenshot`, and the action verbs. Pass
`config: "../web-benchmark/e2e.config.ts"` to `open_session` for a benchmark.
The server process runs the `dist` it started with: after a rebuild, restart
it (`/mcp` in Claude Code) before verifying MCP or engine changes through it.
Several sessions can be open at once (`--max-sessions`, default 4); pass the session id to every call and `close_session` when done.

Use it to write locators (`locate` prints the `screen.*` call), to look at a
surface before testing it, to verify changes to the MCP tools
themselves, and to record a video of what you drove when the engine records
video (both web and mobile do): `start_recording` once the screen is set up,
`stop_recording` for the file paths.

## Drive it like a user

- Run the built CLI, not a unit test harness. Read what it prints and what it
  writes (`.e2e/report.json`, `--reporter list,markdown` for
  `.e2e/summary.md` and `.e2e/failures/`).
- Exercise the failure path too: a change to an error code, a timeout, or a
  policy refusal is verified by triggering it and reading the message a user
  gets.
- Check the side effects: artifacts land where the docs say, and a filled
  secret stays out of every file under `.e2e/` (`grep -r` the value).
- `APP_ALREADY_RUNNING` means another checkout's run holds the app port.
  Wait for it or ask; never stop a process you did not start.
- Mobile: follow `apps/mobile-benchmark/README.md` for devices. One run per
  device at a time.

## Evidence

The PR must show it working (`writing-pr`). Report the surface, what you
ran, and what you saw, with media:

- **Terminal output:** paste the relevant lines of the CLI output as a
  fenced `text` block (ANSI stripped, paths trimmed). This is the primary
  evidence for runner, CLI, and reporter changes.
- **Video:** `--video` (add `--headed` to watch it) records every attempt to
  `.e2e/artifacts/<target>/<test>/.../attempt-<n>/video/`: `video.webm` from
  `@e2e-dev/web`, `video.mp4` from `@e2e-dev/mobile`.
  Attach it for engine, locator, and agent changes a viewer can see.
- **Stills:** cut a frame from the video
  (`ffmpeg -ss <seconds> -i <video> -frames:v 1 after.png`), or screenshot
  the docs page.
- **Bug fixes, main vs branch:** write the regression test first and run it
  while the checkout still matches main, so the failure is captured. Already
  changed the code? Build main beside it:
  `git worktree add /tmp/e2e-main origin/main`, then `pnpm install
  --frozen-lockfile && pnpm build` there and run the same command in both.
- **Upload:** `gh pr create|edit --body-file body.md --attach ./after.png --attach ./video.webm`
  (`gh` 2.99+) uploads each file, rewrites markdown image paths in the body,
  and appends videos as players. With an older `gh`, drag the files into the
  PR in the browser, or say the media is local and why.

If something could not be verified, say so and name the blocker. A confident
claim without evidence is worse than "inconclusive".

## Cleanup

`e2e run` stops the apps it started. `close_session` stops the MCP
session's. Remove a `/tmp/e2e-main` worktree with `git worktree remove`
when done.
