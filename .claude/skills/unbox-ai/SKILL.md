---
name: unbox-ai
description: Analyze AI agent trace files (*.trace.json - gateway or opencode exports, or .devtools/generations.json AI SDK devtools databases, even mid-run while the app writes them) without reading the raw JSON. Use when asked to inspect an agent run, find why it was slow or expensive, check cache efficiency, debug tool calls, or summarize what an agent did. All commands are read-only with bounded output - safe to run freely.
---

# unbox-ai: explore AI traces from the CLI

Traces are too big to read raw (megabytes of duplicated context). `unbox-ai`
normalizes them and answers questions with bounded output. Never `cat` or Read
a trace file - always go through the CLI.

Run via `npx unbox-ai` (or `node dist/cli/index.js` in the unbox-ai repo).

## Workflow

Always start wide, then drill:

```bash
unbox-ai runs <trace>           # multi-run sources only: one line per independent run
unbox-ai summary <trace>        # who/what/cost + one line per generation
unbox-ai tools <trace>          # per-tool usage: calls, failures, time, output size
unbox-ai events <trace>         # table: tokens, latency, cost per generation
unbox-ai event <trace> <idx>    # one generation: metrics + only its NEW messages
unbox-ai messages <trace> --grep <q> [--role r] [--event n] [--limit n]
unbox-ai get <trace> '<path>'   # exact raw value, e.g. events[3].messages[2].content
unbox-ai compare <a> <b>        # A/B: metric deltas + system prompt / tool-set diff
```

- `--json` on summary/events/event/tools/messages for machine-readable output
  (unbounded - prefer the plain forms first).
- `--run <n|id>` scopes any text command to one run of a multi-run source
  (AI SDK devtools databases hold many). Without it they see the whole file
  merged. Keep passing the same `--run` when following printed pointers -
  generation indexes are run-local.
- Truncated output always prints the exact `get` invocation that returns the
  rest. Follow those pointers instead of guessing paths.
- `--grep` accepts regex; invalid regex silently falls back to literal search.
- `tools --all` lists every individual call with args.
- `compare` answers "what changed between these two runs": token/cost/time
  deltas, a task diff (differing tasks make deltas misleading), per-tool
  usage deltas, then a line diff of the system prompt and the tool-set
  changes - added/removed names plus, per changed tool, what changed
  (description or schema). Two runs of one file: `compare <trace> --run 0 --run 1` (first --run
  scopes A, second B). Diff output is bounded; `--json` has the full diff.
  `--trajectory` adds a content-aligned action table (* = differing step,
  - = no counterpart; alignment is LCS over tool sequences, so an extra step
  in one run offsets nothing) - the fastest way to see where two runs
  actually diverged.
- `unbox-ai view <trace>` starts a localhost visualization - only offer this
  to the human; as an agent, stay on the read commands.

## Reading the numbers

- **generation** = one model request/response. **segment** = one conversation
  thread (resets and interleaved agents split threads).
- `caching NN%` = input tokens that were a repeated, cache-eligible prefix
  (real cache reads when the trace reports them, else inferred from repeats).
- cost `-` = the source reports no dollar amounts (AI SDK devtools traces);
  reason about tokens instead.
- `latency NN% prompt wait` = share of model time spent re-reading input
  (TTFT). High = the run is prompt-bound; shrinking resent context cuts both
  cost and wall-clock.
- `re-paid ~N tokens` = identical system prompt/tools re-processed because
  fresh conversations start from zero - a prompt-caching or one-conversation
  opportunity.
- `event` shows only messages NEW in that generation; earlier context is in
  prior events of the same segment.

## Analysis recipes

Cost hotspots (which segment/agent burns the money):

```bash
unbox-ai events <trace> --json | jq 'group_by(.segment) | map({seg: .[0].segment, model: .[0].model, cost: ([.[].cost] | add), in: ([.[].inputTokens] | add)}) | sort_by(-.cost)'
```

Retry loops (same tool + same args repeating = a stuck agent):

```bash
unbox-ai tools <trace> --json | jq 'group_by(.name + (.args|tostring)) | map(select(length > 2) | {call: .[0].name, args: .[0].args, times: length})'
```

Latency outliers: `unbox-ai events <trace>` and scan the latency column;
drill into the outlier with `event`, and check its tool durations in
`tools --all` (wait-style tools show their requested duration).

Failures: `unbox-ai tools <trace>` failed column, then
`messages --grep "error|failed"` for the evidence trail.

## Supported formats

Gateway exports (`{events[]}` with cumulative message snapshots), opencode
session exports (`{info, messages[{info, parts}]}`), and AI SDK devtools
databases (`{runs[], steps[]}`, usually `.devtools/generations.json`) are
auto-detected - `summary` prints which. Unknown files fail with a readable
error; do not retry with other commands.

## Live AI SDK apps (devtools databases)

A project instrumented with `@ai-sdk/devtools` writes every AI SDK call to
`.devtools/generations.json` in the app's cwd - analyze it with the commands
above WHILE the app runs. Each command reads a fresh snapshot, so this is the
way to debug an agent mid-flight:

```bash
unbox-ai runs .devtools/generations.json            # what ran / is running ([live])
unbox-ai summary .devtools/generations.json --run 2 # drill into one run
unbox-ai tools .devtools/generations.json --run 2   # its tool behavior
```

- Always start with `runs` on these files and scope with `--run`; the
  unscoped view merges every run and its indexes shift as the app appends.
- A run marked `[live]` (or a generation with latency 0.00s and no output)
  is still executing - re-run the command for updated state.
- `unbox-ai devtools` serves a live browser viewer of the same file; only
  offer it to the human, as an agent stay on the read commands.
