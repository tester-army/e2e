/**
 * Live check of the OrcaRouter provider: the catalog the account serves, and
 * one forced tool call over a small red image through the constructor this
 * package ships — the shape the `act` loop sends. Run by hand with a real key:
 *
 *   ORCAROUTER_API_KEY=… npx tsx tests/live/orcarouter.ts
 *   ORCAROUTER_API_KEY=… npx tsx tests/live/orcarouter.ts deepseek/deepseek-v4-pro
 *
 * Nothing here runs under `pnpm test`; it needs a credential and the network.
 */
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { createOAuthFetch } from '../../src/oauth/fetch.ts';
import { chatQuery, listModels, visionQuery } from '../../src/oauth/orcarouter-catalog.ts';
import { orcaRouterOrigins } from '../../src/oauth/orcarouter-origins.ts';
import { orcarouter } from '../../src/oauth/orcarouter.ts';
import { createApiKeyProvider } from '../../src/oauth/providers/orcarouter.ts';
import { USER_AGENT, loginHint } from '../../src/oauth/providers.ts';
import { defaultCredentialStore } from '../../src/oauth/store.ts';

const origins = orcaRouterOrigins();
console.log(`auth origin:      ${origins.auth}`);
console.log(`inference origin: ${origins.api}`);

// The same credential-carrying fetch the shipped constructor builds; the
// catalog is per account, so a key is what makes its answer authoritative.
const catalogFetch = createOAuthFetch(createApiKeyProvider({ env: process.env }), {
  store: defaultCredentialStore(),
  userAgent: USER_AGENT,
  loginHint: loginHint('orcarouter'),
});

const chat = await listModels(chatQuery(), origins, { fetch: catalogFetch });
const vision = await listModels(visionQuery(), origins, { fetch: catalogFetch });
console.log(`chat models:   ${chat.models.length} (degraded: ${chat.degraded}${chat.reason === undefined ? '' : `; ${chat.reason}`})`);
console.log(`vision models: ${vision.models.length}`);
console.log(chat.models.map((model) => `  ${model.id}${model.inputModalities.includes('image') ? ' [image]' : ''}`).join('\n'));

const [modelId = 'orcarouter/auto'] = process.argv.slice(2);
if (!chat.models.some((model) => model.id === modelId)) throw new Error(`${modelId} is not in the chat catalog this account serves`);

// An 8x8 red PNG.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4ISeHFTEMLQkAkL9BAbKfPiIAAAAASUVORK5CYII=',
  'base64',
);
const model = orcarouter(modelId);
const started = Date.now();
const result = await generateText({
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What color is this square? Report it with the tool.' }, { type: 'file', data: png, mediaType: 'image/png' }] }],
  tools: { report: tool({ inputSchema: z.object({ color: z.string() }) }) },
  toolChoice: { type: 'tool', toolName: 'report' },
});
console.log(
  JSON.stringify(
    { provider: model.provider, model: model.modelId, ms: Date.now() - started, toolCalls: result.toolCalls.map((call) => ({ name: call.toolName, input: call.input })), usage: result.usage },
    null,
    2,
  ),
);
