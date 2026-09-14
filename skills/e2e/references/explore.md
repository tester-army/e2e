# Exploring without a test

`e2e explore` runs the agent against the app with a goal instead of a test
file. Use it to see what the agent can do with an app before tests exist, to
hunt for regressions on a branch, or to find what is worth turning into a
test. It needs a config with a target and an agent that holds a model,
nothing else.

```bash
npx e2e explore   # goal: "Explore the app and find bugs"
npx e2e explore 'Explore checkout like a first-time buyer and report anything off'
npx e2e explore --target web --max-steps 4 --headed
npx e2e explore 'Hunt for broken forms' --video
```

## What a run does

1. Opens the app on the target's URL.
2. Plans one step: a structured model call reads the goal, the steps and
   findings so far, and the current screen, and answers with a title and a
   concrete charter for one flow, or decides the goal is covered.
3. Runs the charter as an `agent.act()` step with the project's tools plus
   `report_finding`. The agent reports each defect the moment it has evidence:
   title, `issue` or `warning`, severity 1 to 5, expected, actual, reproduction
   steps. The runner adds the path and a redacted screenshot.
4. Repeats until the planner finishes, the step limit, the clock, or three
   failed or blocked steps in a row that reported nothing; then asks for a closing assessment.

A failed step does not end the run: it is recorded, and only reported issues
fail the product verdict. A run whose charters were all blocked stays blocked.
A step that hits its action or time budget ended at its limit and counts as
neither. Configured `credentials`
reach the explorer as step secrets: the planner knows the account names and
usernames, and the agent fills passwords with `type_secret` by name.

## Flags

| Flag | Default | Effect |
| --- | --- | --- |
| `[goal]` | `Explore the app and find bugs` | One quoted sentence: the area and the posture. |
| `--target <id>` | first configured target | The one target to explore. |
| `--agent <name>` | `default` | Build the explorer from another configured agent (`agents.<name>`). |
| `--max-steps <n>` | 8 (1 to 12) | Exploration steps at most. |
| `--timeout <ms>` | 600000 (180000 to 900000) | Wall clock; the last minute is for the assessment. |
| `--headed`, `--reporter`, `--artifacts`, `--debug`, `--ai-trace`, `--video` | as `run` | Same meaning as for `e2e run`. |

Per-step action and model-call budgets default to 40 each; `agent.maxSteps`
and `agent.maxModelCalls` in the config override them. The trace cache is off
and retries are zero for the run.

## Reading the result

Exit code `0`: steps ran, no `issue` was reported, and not every charter was
blocked. Warnings are allowed. Exit code `1`: at least one `issue`, or no
step ran and nothing was found. If every charter was blocked and no `issue`
was reported, the run is `blocked` even with warnings. It keeps the first
blocker's code and explanation, with exit code `1` for automation limits,
`2` for missing credentials or test setup, or `3` for an unavailable
environment. When a charter passes, fails, or exhausts its budget, reported
issues decide the final verdict. Other errors use `2` and `3` as for `run`.

The terminal shows the exploration step by step: each step by its title with
its duration, actions, and findings, and each finding the moment it is
reported as `⚑ high issue  Title (/path)`. At the end a `Findings` section
lists every finding, issues first and the most severe first, each with where
it was seen, its screenshot path, what was expected against what the screen
showed, and the steps that reach it; then the `Assessment` and the summary
(`Findings`, `Steps`, `AI`, `Duration`, `Report`). Severity words: critical 5,
high 4, medium 3, low 2, trivial 1. `.e2e/report.json` has the record under
`run.explore`:

```json
{
  "goal": "...",
  "budgets": { "maxSteps": 8, "timeoutMs": 600000 },
  "ended": "finished | step-limit | time | stuck | aborted",
  "summary": "the closing assessment",
  "steps": [{ "index": 1, "title": "...", "instruction": "...", "status": "passed | failed | blocked | exhausted", "summary": "...", "startedAt": "...", "durationMs": 0 }],
  "findings": [{ "index": 0, "step": 1, "kind": "issue", "severity": 4, "title": "...", "expected": "...", "actual": "...", "reproduction": ["..."], "path": "/cart", "artifactId": "<attempt id>:artifact:2", "reportedAt": "..." }]
}
```

`artifactId` names the evidence screenshot among the attempt's `artifacts` in
`run.results[0]`, where its path, size, and digest are.

Turn a finding into a test: its `reproduction` steps are the `agent.act()`
instructions or `screen.*` actions, and `expected` is the assertion.

## When it does not fit

An agent built with `createAgent({ tools, system })` in the config lends its
tools and guidance to the explorer; a hand-rolled `StepExecutor` is replaced by
the built-in agent for the run, with a notice on stderr. Findings are the
model's claims plus evidence, not verified reproductions: read `actual` against
the screenshot before filing a bug.
