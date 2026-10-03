/**
 * One part of the provider setup on the Models page: `show` is `select`,
 * `install`, `env`, or `config`. All parts on the page share one selection.
 *
 * Mintlify evaluates each snippet export alone, so exports share no module
 * scope. For this reason, one component takes `show`, and the selection is a
 * store on `globalThis` read with `React.useSyncExternalStore`. The server
 * snapshot is the default, and only event handlers write the store.
 *
 * The list comes from https://ai-sdk.dev/providers. It excludes providers
 * without a language model, models without tool calls (Perplexity,
 * llama.cpp, QuiverAI), agent CLIs with their own tool loop (Claude Code,
 * Codex CLI, Gemini CLI, OpenCode, ACP, A2A), browser- and device-only
 * runtimes, packages on the v1 model specification, and packages that do not
 * load as ESM or do not typecheck (Apertis 3.0.0, Requesty 3.6.2).
 * `readsAtLoad` marks providers that throw at construction when their
 * variables are missing.
 */
export const ModelProvider = ({ show }) => {
  const providers = [
    {
      id: 'gateway',
      name: 'Vercel AI Gateway',
      group: 'AI SDK',
      packages: [],
      code: "import { gateway } from 'ai';",
      model: "gateway('openai/gpt-6-luna-fast')",
      env: ['AI_GATEWAY_API_KEY'],
      note: 'You can use a Vercel OIDC token from a linked project instead of a key.',
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway',
    },
    {
      id: 'openai',
      name: 'OpenAI',
      group: 'AI SDK',
      packages: ['@ai-sdk/openai'],
      code: "import { openai } from '@ai-sdk/openai';",
      model: "openai('gpt-6-luna')",
      env: ['OPENAI_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/openai',
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      group: 'AI SDK',
      packages: ['@ai-sdk/anthropic'],
      code: "import { anthropic } from '@ai-sdk/anthropic';",
      model: "anthropic('claude-sonnet-5-5')",
      env: ['ANTHROPIC_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/anthropic',
    },
    {
      id: 'google',
      name: 'Google Generative AI',
      group: 'AI SDK',
      packages: ['@ai-sdk/google'],
      code: "import { google } from '@ai-sdk/google';",
      model: "google('gemini-3.8-flash')",
      env: ['GOOGLE_GENERATIVE_AI_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/google',
    },
    {
      id: 'google-vertex',
      name: 'Google Vertex AI',
      group: 'AI SDK',
      packages: ['@ai-sdk/google-vertex'],
      code: "import { googleVertex } from '@ai-sdk/google-vertex';",
      model: "googleVertex('gemini-3.8-flash')",
      env: ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/google-vertex',
      readsAtLoad: true,
    },
    {
      id: 'azure',
      name: 'Azure OpenAI',
      group: 'AI SDK',
      packages: ['@ai-sdk/azure'],
      code: "import { azure } from '@ai-sdk/azure';",
      model: "azure('your-deployment-name')",
      env: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/azure',
    },
    {
      id: 'amazon-bedrock',
      name: 'Amazon Bedrock',
      group: 'AI SDK',
      packages: ['@ai-sdk/amazon-bedrock'],
      code: "import { amazonBedrock } from '@ai-sdk/amazon-bedrock';",
      model: "amazonBedrock('eu.anthropic.claude-sonnet-4-6')",
      env: ['AWS_REGION', 'AWS_BEARER_TOKEN_BEDROCK'],
      note: 'You can use AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY instead of the bearer token. The eu. model prefix needs an EU region.',
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock',
    },
    {
      id: 'anthropic-aws',
      name: 'Claude Platform on AWS',
      group: 'AI SDK',
      packages: ['@ai-sdk/anthropic-aws'],
      code: "import { anthropicAws } from '@ai-sdk/anthropic-aws';",
      model: "anthropicAws('claude-sonnet-5-5')",
      env: ['AWS_REGION', 'ANTHROPIC_AWS_WORKSPACE_ID', 'ANTHROPIC_AWS_API_KEY'],
      note: 'You can use AWS credentials instead of the API key.',
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/anthropic-aws',
      readsAtLoad: true,
    },
    {
      id: 'xai',
      name: 'xAI Grok',
      group: 'AI SDK',
      packages: ['@ai-sdk/xai'],
      code: "import { xai } from '@ai-sdk/xai';",
      model: "xai('grok-4.7')",
      env: ['XAI_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/xai',
    },
    {
      id: 'mistral',
      name: 'Mistral AI',
      group: 'AI SDK',
      packages: ['@ai-sdk/mistral'],
      code: "import { mistral } from '@ai-sdk/mistral';",
      model: "mistral('mistral-medium-3.5')",
      env: ['MISTRAL_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/mistral',
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      group: 'AI SDK',
      packages: ['@ai-sdk/deepseek'],
      code: "import { deepSeek } from '@ai-sdk/deepseek';",
      model: "deepSeek('deepseek-v4-flash')",
      env: ['DEEPSEEK_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/deepseek',
    },
    {
      id: 'moonshotai',
      name: 'Moonshot AI',
      group: 'AI SDK',
      packages: ['@ai-sdk/moonshotai'],
      code: "import { moonshotai } from '@ai-sdk/moonshotai';",
      model: "moonshotai('kimi-k3')",
      env: ['MOONSHOT_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/moonshotai',
    },
    {
      id: 'alibaba',
      name: 'Alibaba',
      group: 'AI SDK',
      packages: ['@ai-sdk/alibaba'],
      code: "import { alibaba } from '@ai-sdk/alibaba';",
      model: "alibaba('qwen3-max')",
      env: ['ALIBABA_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/alibaba',
    },
    {
      id: 'zai',
      name: 'Z.AI',
      group: 'AI SDK',
      packages: ['@ai-sdk/zai'],
      code: "import { zai } from '@ai-sdk/zai';",
      model: "zai('glm-5.3')",
      env: ['ZAI_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/zai',
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      group: 'AI SDK',
      packages: ['@ai-sdk/minimax'],
      code: "import { minimax } from '@ai-sdk/minimax';",
      model: "minimax('minimax-m3')",
      env: ['MINIMAX_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/minimax',
    },
    {
      id: 'groq',
      name: 'Groq',
      group: 'AI SDK',
      packages: ['@ai-sdk/groq'],
      code: "import { groq } from '@ai-sdk/groq';",
      model: "groq('meta-llama/llama-4-scout-17b-16e-instruct')",
      env: ['GROQ_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/groq',
    },
    {
      id: 'cerebras',
      name: 'Cerebras',
      group: 'AI SDK',
      packages: ['@ai-sdk/cerebras'],
      code: "import { cerebras } from '@ai-sdk/cerebras';",
      model: "cerebras('gemma-4-31b')",
      env: ['CEREBRAS_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/cerebras',
    },
    {
      id: 'fireworks',
      name: 'Fireworks',
      group: 'AI SDK',
      packages: ['@ai-sdk/fireworks'],
      code: "import { fireworks } from '@ai-sdk/fireworks';",
      model: "fireworks('accounts/fireworks/models/kimi-k2p6')",
      env: ['FIREWORKS_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/fireworks',
    },
    {
      id: 'togetherai',
      name: 'Together.ai',
      group: 'AI SDK',
      packages: ['@ai-sdk/togetherai'],
      code: "import { togetherai } from '@ai-sdk/togetherai';",
      model: "togetherai('mistralai/Mixtral-8x22B-Instruct-v0.1')",
      env: ['TOGETHER_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/togetherai',
    },
    {
      id: 'deepinfra',
      name: 'DeepInfra',
      group: 'AI SDK',
      packages: ['@ai-sdk/deepinfra'],
      code: "import { deepInfra } from '@ai-sdk/deepinfra';",
      model: "deepInfra('meta-llama/Llama-3.3-70B-Instruct')",
      env: ['DEEPINFRA_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/deepinfra',
    },
    {
      id: 'cohere',
      name: 'Cohere',
      group: 'AI SDK',
      packages: ['@ai-sdk/cohere'],
      code: "import { cohere } from '@ai-sdk/cohere';",
      model: "cohere('command-a-03-2025')",
      env: ['COHERE_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/cohere',
    },
    {
      id: 'huggingface',
      name: 'Hugging Face',
      group: 'AI SDK',
      packages: ['@ai-sdk/huggingface'],
      code: "import { huggingFace } from '@ai-sdk/huggingface';",
      model: "huggingFace('Qwen/Qwen2.5-VL-7B-Instruct')",
      env: ['HUGGINGFACE_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/huggingface',
    },
    {
      id: 'baseten',
      name: 'Baseten',
      group: 'AI SDK',
      packages: ['@ai-sdk/baseten'],
      code: "import { baseten } from '@ai-sdk/baseten';",
      model: "baseten('moonshotai/Kimi-K2-Instruct-0905')",
      env: ['BASETEN_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/baseten',
    },
    {
      id: 'gmicloud',
      name: 'GMI Cloud',
      group: 'AI SDK',
      packages: ['@ai-sdk/gmicloud'],
      code: "import { gmicloud } from '@ai-sdk/gmicloud';",
      model: "gmicloud('deepseek-ai/DeepSeek-V4-Flash-0731')",
      env: ['GMI_CLOUD_APIKEY'],
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/gmicloud',
    },
    {
      id: 'open-responses',
      name: 'Open Responses endpoint',
      group: 'AI SDK',
      packages: ['@ai-sdk/open-responses'],
      code: `import { createOpenResponses } from '@ai-sdk/open-responses';

const local = createOpenResponses({
  name: 'local',
  url: 'http://localhost:1234/v1/responses',
});`,
      model: "local('your-model-id')",
      env: [],
      note: 'Use a server that has the Responses API. Add apiKey if the server needs a key.',
      docs: 'https://ai-sdk.dev/providers/ai-sdk-providers/open-responses',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      group: 'Community',
      packages: ['@openrouter/ai-sdk-provider'],
      code: "import { openrouter } from '@openrouter/ai-sdk-provider';",
      model: "openrouter('openai/gpt-6-luna-fast')",
      env: ['OPENROUTER_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/openrouter',
    },
    {
      id: 'ollama',
      name: 'Ollama',
      group: 'Community',
      packages: ['ollama-ai-provider-v2'],
      code: "import { ollama } from 'ollama-ai-provider-v2';",
      model: "ollama('qwen3:4b')",
      env: [],
      note: 'Start Ollama on its default port.',
      docs: 'https://ai-sdk.dev/providers/community-providers/ollama',
    },
    {
      id: 'helicone',
      name: 'Helicone',
      group: 'Community',
      packages: ['@helicone/ai-sdk-provider'],
      code: `import { createHelicone } from '@helicone/ai-sdk-provider';

const helicone = createHelicone({ apiKey: process.env.HELICONE_API_KEY });`,
      model: "helicone('claude-4.5-haiku')",
      env: ['HELICONE_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/helicone',
    },
    {
      id: 'neon',
      name: 'Neon AI Gateway',
      group: 'Community',
      packages: ['@neon/ai-sdk-provider'],
      code: "import { neon } from '@neon/ai-sdk-provider';",
      model: "neon('gpt-5-mini')",
      env: ['NEON_AI_GATEWAY_BASE_URL', 'NEON_AI_GATEWAY_TOKEN'],
      docs: 'https://ai-sdk.dev/providers/community-providers/neon-ai-gateway',
    },
    {
      id: 'aihubmix',
      name: 'AIHubMix',
      group: 'Community',
      packages: ['@aihubmix/ai-sdk-provider'],
      code: "import { aihubmix } from '@aihubmix/ai-sdk-provider';",
      model: "aihubmix('gemini-2.5-flash')",
      env: ['AIHUBMIX_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/aihubmix',
      readsAtLoad: true,
    },
    {
      id: 'aimlapi',
      name: 'AI/ML API',
      group: 'Community',
      packages: ['@ai-ml.api/aimlapi-vercel-ai'],
      code: "import { aimlapi } from '@ai-ml.api/aimlapi-vercel-ai';",
      model: "aimlapi('gpt-4o')",
      env: ['AIMLAPI_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/aimlapi',
    },
    {
      id: 'cencori',
      name: 'Cencori',
      group: 'Community',
      packages: ['cencori'],
      code: "import { cencori } from 'cencori/vercel';",
      model: "cencori('gpt-4o')",
      env: ['CENCORI_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/cencori',
      readsAtLoad: true,
    },
    {
      id: 'crusoe',
      name: 'Crusoe',
      group: 'Community',
      packages: ['crusoe-ai-provider'],
      code: "import { crusoe } from 'crusoe-ai-provider';",
      model: "crusoe('zai/GLM-5.2')",
      env: ['CRUSOE_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/crusoe',
    },
    {
      id: 'friendliai',
      name: 'FriendliAI',
      group: 'Community',
      packages: ['@friendliai/ai-provider'],
      code: "import { friendli } from '@friendliai/ai-provider';",
      model: "friendli('meta-llama-3.3-70b-instruct')",
      env: ['FRIENDLI_TOKEN'],
      docs: 'https://ai-sdk.dev/providers/community-providers/friendliai',
    },
    {
      id: 'runpod',
      name: 'Runpod',
      group: 'Community',
      packages: ['@runpod/ai-sdk-provider'],
      code: "import { runpod } from '@runpod/ai-sdk-provider';",
      model: "runpod('qwen/qwen3-32b-awq')",
      env: ['RUNPOD_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/runpod',
    },
    {
      id: 'sambanova',
      name: 'SambaNova',
      group: 'Community',
      packages: ['sambanova-ai-provider'],
      code: "import { sambanova } from 'sambanova-ai-provider';",
      model: "sambanova('Meta-Llama-3.1-70B-Instruct')",
      env: ['SAMBANOVA_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/sambanova',
    },
    {
      id: 'telnyx',
      name: 'Telnyx',
      group: 'Community',
      packages: ['@telnyx/ai-sdk-provider'],
      code: "import { telnyx } from '@telnyx/ai-sdk-provider';",
      model: "telnyx('Qwen/Qwen3-235B-A22B')",
      env: ['TELNYX_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/telnyx',
      readsAtLoad: true,
    },
    {
      id: 'zhipu',
      name: 'Zhipu AI (BigModel)',
      group: 'Community',
      packages: ['zhipu-ai-provider'],
      code: "import { zhipu } from 'zhipu-ai-provider';",
      model: "zhipu('glm-4-plus')",
      env: ['ZHIPU_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/zhipu',
    },
    {
      id: 'sap-ai',
      name: 'SAP AI Core',
      group: 'Community',
      packages: ['@jerome-benoit/sap-ai-provider'],
      code: "import { sapai } from '@jerome-benoit/sap-ai-provider';",
      model: "sapai('gpt-4.1')",
      env: ['AICORE_SERVICE_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/sap-ai',
    },
    {
      id: 'azure-ai',
      name: 'Azure AI Foundry',
      group: 'Community',
      packages: ['@quail-ai/azure-ai-provider'],
      code: `import { createAzure } from '@quail-ai/azure-ai-provider';

const azure = createAzure({
  endpoint: process.env.AZURE_API_ENDPOINT,
  apiKey: process.env.AZURE_API_KEY,
});`,
      model: "azure('your-deployment-name')",
      env: ['AZURE_API_ENDPOINT', 'AZURE_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/azure-ai',
      readsAtLoad: true,
    },
    {
      id: 'interfaze',
      name: 'Interfaze',
      group: 'Community',
      packages: ['@interfaze-ai/ai-sdk'],
      code: "import { interfaze } from '@interfaze-ai/ai-sdk';",
      model: "interfaze('interfaze-beta')",
      env: ['INTERFAZE_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/interfaze',
    },
    {
      id: 'ollm',
      name: 'OLLM',
      group: 'Community',
      packages: ['@ofoundation/ollm'],
      code: `import { createOLLM } from '@ofoundation/ollm';

const ollm = createOLLM({ apiKey: process.env.OLLM_API_KEY });`,
      model: "ollm.chatModel('near/GLM-4.6')",
      env: ['OLLM_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/community-providers/ollm',
    },
    {
      id: 'qvac',
      name: 'QVAC',
      group: 'Community',
      packages: ['@qvac/ai-sdk-provider'],
      code: `import { createQvac } from '@qvac/ai-sdk-provider';

const qvac = createQvac({
  baseURL: 'http://127.0.0.1:11434/v1',
  apiKey: 'qvac',
});`,
      model: "qvac('qwen3.5-0.8b')",
      env: [],
      note: 'Start qvac serve. Set baseURL to its port.',
      docs: 'https://ai-sdk.dev/providers/community-providers/qvac',
    },
    {
      id: 'openai-compatible',
      name: 'Any OpenAI-compatible endpoint',
      group: 'OpenAI-compatible',
      packages: ['@ai-sdk/openai-compatible'],
      code: `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const local = createOpenAICompatible({
  name: 'local',
  baseURL: 'http://127.0.0.1:11434/v1',
  // apiKey: process.env.LLM_API_KEY,
});`,
      model: "local.chatModel('your-model-id')",
      env: [],
      note: 'Use vLLM, llama-server, LiteLLM, or a different server with /v1/chat/completions.',
      docs: 'https://ai-sdk.dev/providers/openai-compatible-providers',
    },
    {
      id: 'lmstudio',
      name: 'LM Studio',
      group: 'OpenAI-compatible',
      packages: ['@ai-sdk/openai-compatible'],
      code: `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const lmstudio = createOpenAICompatible({
  name: 'lmstudio',
  baseURL: 'http://localhost:1234/v1',
});`,
      model: "lmstudio('llama-3.2-1b')",
      env: [],
      docs: 'https://ai-sdk.dev/providers/openai-compatible-providers/lmstudio',
    },
    {
      id: 'nim',
      name: 'NVIDIA NIM',
      group: 'OpenAI-compatible',
      packages: ['@ai-sdk/openai-compatible'],
      code: `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const nim = createOpenAICompatible({
  name: 'nim',
  baseURL: 'https://integrate.api.nvidia.com/v1',
  headers: { Authorization: \`Bearer \${process.env.NIM_API_KEY}\` },
});`,
      model: "nim.chatModel('meta/llama-3.3-70b-instruct')",
      env: ['NIM_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/openai-compatible-providers/nim',
    },
    {
      id: 'heroku',
      name: 'Heroku',
      group: 'OpenAI-compatible',
      packages: ['@ai-sdk/openai-compatible'],
      code: `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const heroku = createOpenAICompatible({
  name: 'heroku',
  baseURL: process.env.INFERENCE_URL + '/v1',
  apiKey: process.env.INFERENCE_KEY,
});`,
      model: "heroku('claude-3-5-haiku')",
      env: ['INFERENCE_URL', 'INFERENCE_KEY'],
      docs: 'https://ai-sdk.dev/providers/openai-compatible-providers/heroku',
    },
    {
      id: 'clarifai',
      name: 'Clarifai',
      group: 'OpenAI-compatible',
      packages: ['@ai-sdk/openai-compatible'],
      code: `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const clarifai = createOpenAICompatible({
  name: 'clarifai',
  baseURL: 'https://api.clarifai.com/v2/ext/openai/v1',
  apiKey: process.env.CLARIFAI_PAT,
});`,
      model: "clarifai.chatModel('https://clarifai.com/deepseek-ai/deepseek-chat/models/DeepSeek-R1-0528-Qwen3-8B')",
      env: ['CLARIFAI_PAT'],
      docs: 'https://ai-sdk.dev/providers/openai-compatible-providers/clarifai',
    },
    {
      id: 'nearai',
      name: 'NEAR AI Cloud',
      group: 'OpenAI-compatible',
      packages: ['@ai-sdk/openai-compatible'],
      code: `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const nearai = createOpenAICompatible({
  name: 'nearai',
  baseURL: 'https://cloud-api.near.ai/v1',
  apiKey: process.env.NEARAI_API_KEY,
});`,
      model: "nearai('zai-org/GLM-5.1-FP8')",
      env: ['NEARAI_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/openai-compatible-providers/nearai',
    },
    {
      id: 'modelrush',
      name: 'ModelRush',
      group: 'OpenAI-compatible',
      packages: ['@ai-sdk/openai-compatible'],
      code: `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const modelrush = createOpenAICompatible({
  name: 'modelrush',
  baseURL: 'https://api.modelrush.ai/v1',
  apiKey: process.env.MODELRUSH_API_KEY,
});`,
      model: "modelrush.chatModel('modelrush/deepseek-v4-flash-0731')",
      env: ['MODELRUSH_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/openai-compatible-providers/modelrush',
    },
    {
      id: 'cheaper-inference',
      name: 'Cheaper Inference',
      group: 'OpenAI-compatible',
      packages: ['@ai-sdk/openai-compatible'],
      code: `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const cheaperInference = createOpenAICompatible({
  name: 'cheaper-inference',
  baseURL: 'https://api.cheaperinference.com/v1',
  apiKey: process.env.CHEAPER_INFERENCE_API_KEY,
});`,
      model: "cheaperInference('gpt-5.4')",
      env: ['CHEAPER_INFERENCE_API_KEY'],
      docs: 'https://ai-sdk.dev/providers/openai-compatible-providers/cheaper-inference',
    },
  ];
  const groups = [
    ['AI SDK', 'AI SDK providers'],
    ['Community', 'Community providers'],
    ['OpenAI-compatible', 'OpenAI-compatible endpoints'],
  ];
  const managers = [
    ['npm', 'npm install -D'],
    ['pnpm', 'pnpm add -D'],
    ['bun', 'bun add -d'],
  ];
  const initial = { providerId: providers[0].id, manager: 'npm' };

  const store = (globalThis[Symbol.for('e2e.docs.modelProvider')] ??= (() => {
    const listeners = new Set();
    const self = {
      state: initial,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      update(patch) {
        self.state = { ...self.state, ...patch };
        for (const listener of listeners) listener();
      },
    };
    return self;
  })());
  const state = React.useSyncExternalStore(
    store.subscribe,
    () => store.state,
    () => initial,
  );

  const provider = providers.find((p) => p.id === state.providerId);
  const install = [
    managers.find(([name]) => name === state.manager)[1],
    'ai',
    ...provider.packages,
  ].join(' ');
  const env = provider.env.map((name) => `export ${name}=...`).join('\n');
  const config = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
${provider.code}

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  agents: { default: { model: ${provider.model} } },
} satisfies E2EConfig;`;

  /** Mintlify's own code block: Shiki highlighting in the site theme, and its copy button. */
  const code = (text, language) => <CodeBlock language={language}>{text}</CodeBlock>;

  const part = (title, body, aside = null) => (
    <div className="provider-part">
      <div className="provider-part-header">
        <span>
          {title}
          <span className="provider-part-provider"> · {provider.name}</span>
        </span>
        {aside}
      </div>
      {body}
    </div>
  );

  if (show === 'select') {
    return (
      <div className="provider-part provider-part-select">
        <div className="provider-part-header">
          <label htmlFor="provider-select">Provider</label>
          <select
            id="provider-select"
            value={provider.id}
            onChange={(event) => store.update({ providerId: event.target.value })}
          >
            {groups.map(([group, label]) => (
              <optgroup key={group} label={label}>
                {providers
                  .filter((p) => p.group === group)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <a href={provider.docs} target="_blank" rel="noreferrer">
            Provider docs
          </a>
        </div>
      </div>
    );
  }

  if (show === 'install') {
    return part(
      'Install',
      code(install, 'bash'),
      <div className="provider-part-tabs" role="group" aria-label="Package manager">
        {managers.map(([name]) => (
          <button
            key={name}
            type="button"
            aria-pressed={state.manager === name}
            onClick={() => store.update({ manager: name })}
          >
            {name}
          </button>
        ))}
      </div>,
    );
  }

  if (show === 'env') {
    return part(
      'Environment',
      <>
        {provider.env.length === 0 ? (
          <p className="provider-part-text">No variables.</p>
        ) : (
          code(env, 'bash')
        )}
        {provider.readsAtLoad || provider.note ? (
          <p className="provider-part-text provider-part-note">
            {[
              provider.readsAtLoad
                ? 'This provider reads the variables when the config loads. If one is missing, all runs stop with CONFIG_LOAD_FAILED.'
                : null,
              provider.note,
            ]
              .filter(Boolean)
              .join(' ')}
          </p>
        ) : null}
      </>,
    );
  }

  if (show === 'config') {
    return part('e2e.config.ts', code(config, 'ts'));
  }

  return null;
};
