/**
 * The model gateways `e2e init` offers. Each is one AI SDK provider package
 * and the line that constructs a model with it; the runner itself knows none
 * of them and takes the constructed instance. Adding a gateway is adding an
 * entry here.
 */

import { siblingDependency } from './versions.ts';

export type GatewayId = 'vercel' | 'openrouter' | 'openai-compatible' | 'chatgpt' | 'copilot' | 'grok';

export interface GatewayPreset {
  readonly id: GatewayId;
  readonly label: string;
  readonly hint: string;
  /** Packages besides `ai` the generated config imports from. */
  readonly dependencies: Readonly<Record<string, string>>;
  readonly import: string;
  /** The comment line above the model, naming who serves it and which variable it reads, or which sign-in it uses. */
  readonly comment: string;
  /** For a subscription: the `e2e login` provider that signs in, which init names as the next step. */
  readonly login?: string;
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
  {
    id: 'chatgpt',
    label: 'ChatGPT Plus/Pro subscription',
    hint: 'your ChatGPT plan through the Codex sign-in',
    dependencies: { ...siblingDependency('@e2edev/oauth'), '@ai-sdk/openai': '^4.0.0' },
    import: "import { chatgpt } from '@e2edev/oauth/chatgpt';",
    comment: 'Your ChatGPT subscription serves the model; sign in once with `e2e login openai-codex`.',
    login: 'openai-codex',
    model: () => "chatgpt('gpt-5.5')",
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot subscription',
    hint: 'your Copilot plan: OpenAI, Anthropic, Google, and xAI models',
    dependencies: { ...siblingDependency('@e2edev/oauth'), '@ai-sdk/openai-compatible': '^3.0.0' },
    import: "import { copilot } from '@e2edev/oauth/copilot';",
    comment: 'Your GitHub Copilot subscription serves the model; sign in once with `e2e login github-copilot`.',
    login: 'github-copilot',
    model: () => "copilot('claude-sonnet-5')",
  },
  {
    id: 'grok',
    label: 'SuperGrok subscription',
    hint: 'your SuperGrok or X Premium+ plan',
    dependencies: { ...siblingDependency('@e2edev/oauth'), '@ai-sdk/xai': '^5.0.0' },
    import: "import { grok } from '@e2edev/oauth/grok';",
    comment: 'Your SuperGrok subscription serves the model; sign in once with `e2e login xai`.',
    login: 'xai',
    model: () => "grok('grok-4')",
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
