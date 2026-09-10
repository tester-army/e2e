---
"@e2edev/e2e": minor
---

The model is always an AI SDK instance the config constructs, and the runner
has no gateway of its own. `provider/model-id` strings and the `ModelConfig`
object are gone, along with `E2E_MODEL`, `E2E_VISION_MODEL`,
`E2E_MODEL_API_KEY`, `E2E_MODEL_ENDPOINT`, and the `AI_GATEWAY_API_KEY`
fallback: every one of them quietly routed through the Vercel AI Gateway,
which the runner is not supposed to know about. Write the constructor
instead: `gateway('openai/gpt-5.4-mini')` from `ai` for the Vercel AI Gateway
(reads `AI_GATEWAY_API_KEY`), `openrouter('openai/gpt-5.4-mini')` from
`@openrouter/ai-sdk-provider` (reads `OPENROUTER_API_KEY`),
`createOpenAICompatible({ name, baseURL }).chatModel('llama3.2')` from
`@ai-sdk/openai-compatible` for any OpenAI-compatible endpoint, or a provider's
own package. A string in `agent.model`, `agent.visionModel`, or
`createAgent({ model })` is `INVALID_CONFIG` naming the constructor to write.

`e2e init` asks which gateway agent steps use (Vercel AI Gateway, OpenRouter,
an OpenAI-compatible endpoint with its URL, or none) instead of a yes/no on AI,
adds that provider package, and writes the import and the constructor into
`e2e.config.ts`; `--yes` picks the Vercel AI Gateway and still writes it out.
Credentials are the provider's business: a missing key is the provider's own
error on the first agent step, and a rejected one is reported as such. Reports
record the instance's provider and model id, OpenRouter's per-request cost is
read from its usage accounting, and telemetry gains `model_gateway`, the AI
SDK provider that served the first model-backed step.
