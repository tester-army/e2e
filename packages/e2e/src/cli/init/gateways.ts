/**
 * The model gateways `e2e init` offers. Each is one AI SDK provider package
 * and the line that constructs a model with it; the runner itself knows none
 * of them and takes the constructed instance. Adding a gateway is adding an
 * entry here.
 */

export type GatewayId = 'vercel' | 'openrouter' | 'openai-compatible';

export interface GatewayPreset {
  readonly id: GatewayId;
  readonly label: string;
  readonly hint: string;
  /** Packages besides `ai` the generated config imports from. */
  readonly dependencies: Readonly<Record<string, string>>;
  readonly import: string;
  /** The comment line above the model, naming who serves it and which variable it reads. */
  readonly comment: string;
  /** The model expression, with the endpoint the user typed for an OpenAI-compatible one. */
  model(endpoint: string | undefined): string;
}

export const GATEWAYS: readonly GatewayPreset[] = [
  {
    id: 'vercel',
    label: 'Vercel AI Gateway',
    hint: 'one key for every provider; reads AI_GATEWAY_API_KEY',
    dependencies: {},
    import: "import { gateway } from 'ai';",
    comment: 'The Vercel AI Gateway serves the model id and reads AI_GATEWAY_API_KEY.',
    model: () => "gateway('openai/gpt-5.6-luna')",
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'one key for every provider; reads OPENROUTER_API_KEY',
    dependencies: { '@openrouter/ai-sdk-provider': '^3.0.0' },
    import: "import { openrouter } from '@openrouter/ai-sdk-provider';",
    comment: 'OpenRouter serves the model id and reads OPENROUTER_API_KEY.',
    model: () => "openrouter('openai/gpt-5.6-luna')",
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    hint: 'any /v1 chat endpoint: Ollama, vLLM, LiteLLM, a vendor API',
    dependencies: { '@ai-sdk/openai-compatible': '^3.0.0' },
    import: "import { createOpenAICompatible } from '@ai-sdk/openai-compatible';",
    comment: 'The endpoint serves the model id over the OpenAI chat API; pass apiKey when it needs one.',
    model: (endpoint) =>
      `createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: ${quote(endpoint ?? 'http://127.0.0.1:11434/v1')},
        // apiKey: process.env.LLM_API_KEY,
      }).chatModel('gpt-5.6-luna')`,
  },
];

export function getGatewayPreset(id: GatewayId): GatewayPreset {
  const preset = GATEWAYS.find((gateway) => gateway.id === id);
  if (preset === undefined) throw new Error(`unknown gateway: ${id}`);
  return preset;
}

/** A single-quoted TypeScript string literal. */
function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}
