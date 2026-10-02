/**
 * The model gateways `e2e init` offers. Each is one AI SDK provider package
 * and the line that constructs a model with it; the runner itself knows none
 * of them and takes the constructed instance. Adding a gateway is adding an
 * entry here.
 */

export type GatewayId = 'vercel' | 'openrouter' | 'orcarouter' | 'orcarouter-auth' | 'openai-compatible' | 'chatgpt' | 'copilot' | 'grok';

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
    comment: 'The Vercel AI Gateway serves the model id and reads AI_GATEWAY_API_KEY, or the OIDC token of a linked Vercel project.',
    model: () => "gateway('openai/gpt-6-luna-fast')",
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'one key for every provider; reads OPENROUTER_API_KEY',
    dependencies: { '@openrouter/ai-sdk-provider': '^3.0.0' },
    import: "import { openrouter } from '@openrouter/ai-sdk-provider';",
    comment: 'OpenRouter serves the model id and reads OPENROUTER_API_KEY.',
    model: () => "openrouter('openai/gpt-6-luna-fast')",
  },
  {
    // The routing entry is the one id the fallback catalog always carries, so a
    // scaffold never names a model the live catalog has since moved on. The
    // other ids are listed by `e2e models orcarouter`.
    id: 'orcarouter',
    label: 'OrcaRouter (API key)',
    hint: 'one key for every provider; reads ORCAROUTER_API_KEY',
    dependencies: { '@ai-sdk/openai-compatible': '^3.0.0' },
    import: "import { orcarouter } from 'e2e/oauth/orcarouter';",
    comment: 'OrcaRouter serves the model id and reads ORCAROUTER_API_KEY; orcarouter/auto routes to a model that fits. Paste a key with `e2e login orcarouter`; `e2e models orcarouter` lists the ids.',
    model: () => "orcarouter('orcarouter/auto')",
  },
  {
    id: 'orcarouter-auth',
    label: 'OrcaRouter (sign in)',
    hint: 'authorize in a browser; OrcaRouter issues the key',
    dependencies: { '@ai-sdk/openai-compatible': '^3.0.0' },
    import: "import { orcarouterAuth } from 'e2e/oauth/orcarouter-auth';",
    comment: 'Your OrcaRouter account serves the model after a browser sign-in that issues the key; sign in once with `e2e login orcarouter-oauth`, `e2e models orcarouter` lists the ids.',
    login: 'orcarouter-oauth',
    model: () => "orcarouterAuth('orcarouter/auto')",
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
      }).chatModel('gpt-6-luna')`,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT Plus/Pro subscription',
    hint: 'your ChatGPT plan through the Codex sign-in',
    dependencies: { '@ai-sdk/openai': '^4.0.0' },
    import: "import { chatgpt } from 'e2e/oauth/chatgpt';",
    comment: 'Your ChatGPT subscription serves the model; sign in once with `e2e login openai`, `e2e models openai` lists the ids.',
    login: 'openai',
    model: () => "chatgpt('gpt-6-luna')",
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot subscription',
    hint: 'your Copilot plan: OpenAI, Anthropic, Google, and SpaceXAI models',
    dependencies: { '@ai-sdk/openai-compatible': '^3.0.0' },
    import: "import { copilot } from 'e2e/oauth/copilot';",
    comment: 'Your GitHub Copilot subscription serves the model; sign in once with `e2e login github-copilot`, `e2e models github-copilot` lists the ids.',
    login: 'github-copilot',
    model: () => "copilot('claude-sonnet-5')",
  },
  {
    id: 'grok',
    label: 'SuperGrok subscription',
    hint: 'your SuperGrok or X Premium+ plan',
    dependencies: { '@ai-sdk/xai': '^5.0.0' },
    import: "import { grok } from 'e2e/oauth/grok';",
    comment: 'Your SuperGrok subscription serves the model; sign in once with `e2e login spacexai`, `e2e models spacexai` lists the ids.',
    login: 'spacexai',
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
