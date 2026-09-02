---
'e2e': minor
---

`e2e run --ai-trace` records every model call of a run to `.e2e/ai-trace.json`
in the AI SDK devtools database shape (`{ runs[], steps[] }`), so a trace
viewer such as unbox-ai opens it as is: `npx unbox-ai .e2e/ai-trace.json`.

Each agent step is one run named after the test and the step
(`todos › adds one · agent.act "add a todo"`), with one entry per model round
trip: an `act` turn, a `waitFor` poll, a judgment's repair round. A generation
a project tool makes nests under its caller. Every entry carries the prompt as
sent (system prompt first), the prepared tool definitions with their JSON
schemas, the response messages, usage, model latency, and provider metadata
(AI Gateway cost included). Child-process workers ship their records over the
worker channel and the runner writes one file at the end, ordered by time. The
trace is the model's view only: observations reach it already redacted, and
image evidence is recorded by byte size, never by pixels.

`RunOptions.aiTrace` and `RunOutcome.aiTracePath` expose the same for the
programmatic runner; `e2e init` ignores the new file.
