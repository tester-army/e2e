/**
 * The OrcaRouter model catalog: which records a capability filter keeps, and
 * what happens when the live catalog cannot be read.
 *
 * The fixtures are shaped like the endpoint's real answer (verified against
 * `GET https://api.orcarouter.ai/v1/models`): `data[]` of records carrying
 * `supported_endpoint_types` and `architecture.input_modalities`. Capabilities
 * are read from those fields only — never inferred from a model's name — so a
 * record that declares nothing fails closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOAuthFetch } from '../../../src/oauth/fetch.ts';
import {
  CHAT_ENDPOINT_TYPES,
  VERIFIED_FALLBACK_CATALOG,
  chatQuery,
  describeModels,
  embeddingQuery,
  imageQuery,
  listModels,
  rerankQuery,
  selectModels,
  videoQuery,
  type CatalogModel,
} from '../../../src/oauth/orcarouter-catalog.ts';
import { createApiKeyProvider } from '../../../src/oauth/providers/orcarouter.ts';
import { orcaRouterOrigins } from '../../../src/oauth/orcarouter-origins.ts';
import { MemoryCredentialStore } from './helpers/store.ts';
import { json, useServers, type Received } from './helpers/server.ts';

const serve = useServers(afterEach);
const TEST_KEY = 'sk-orca-test-0123456789';

/**
 * The operator's own environment must never reach a test: a real
 * ORCAROUTER_API_KEY here would change what these tests assert and leak into
 * a failure message. Every OrcaRouter variable is cleared for the file.
 */
beforeEach(() => {
  for (const name of ['ORCAROUTER_API_KEY', 'ORCA_BASE_URL', 'ORCA_AUTH_BASE_URL', 'ORCA_API_BASE_URL']) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});


/** The catalog request goes through the same fetch the inference calls use, with a fake login. */
function listingFetch(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const store = new MemoryCredentialStore({ orcarouter: { access: TEST_KEY, refresh: '', expires: 0 } });
  return createOAuthFetch(createApiKeyProvider({ env: {} }), { store, userAgent: 'test' });
}

/** The catalog fixture, mirroring the endpoint's real shape. */
const LIVE = {
  object: 'list',
  success: true,
  data: [
    { id: 'orcarouter/auto', object: 'model', supported_endpoint_types: ['openai', 'openai-response', 'anthropic', 'gemini'] },
    { id: 'deepseek/deepseek-v4-pro', object: 'model', context_length: 1_048_576, supported_endpoint_types: ['openai', 'openai-response'], architecture: { input_modalities: ['text'], output_modalities: null } },
    { id: 'deepseek/deepseek-v4-flash-vision-exp', object: 'model', context_length: 1_048_576, supported_endpoint_types: ['openai', 'openai-response', 'anthropic'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    // Not a chat model: declaring only image generation must keep it out of every chat list.
    { id: 'vendor/image-only', supported_endpoint_types: ['image-generation'] },
    // A record the client cannot speak, plus a made-up endpoint type.
    { id: 'vendor/unknown-endpoint', supported_endpoint_types: ['something-else', 'openai-video'] },
    { id: 'vendor/no-metadata' },
    { name: 'no id at all' },
  ],
};

describe('reading the live catalog', () => {
  it('keeps vendor/model ids verbatim and reads capabilities from the record only', async () => {
    const api = await serve((_request, response) => json(response, 200, LIVE));
    const result = await listModels(chatQuery(), orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch() });
    expect(result.degraded).toBe(false);
    expect(result.models.map((model) => model.id)).toEqual([
      'orcarouter/auto',
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash-vision-exp',
    ]);
    const vision = result.models.find((model) => model.id === 'deepseek/deepseek-v4-flash-vision-exp')!;
    expect(vision.inputModalities).toEqual(['text', 'image']);
    expect(vision.contextLength).toBe(1_048_576);
  });

  it('requests the catalog on the inference origin, with the capability parameter, through the login', async () => {
    const seen: Received[] = [];
    const api = await serve((request, response) => {
      seen.push(request);
      json(response, 200, LIVE);
    });
    await listModels(chatQuery(), orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch() });
    expect(seen[0]!.url).toBe('/v1/models?capability=chat');
    expect(seen[0]!.headers['authorization']).toBe(`Bearer ${TEST_KEY}`);
  });

  it('never returns a free-text model the catalog did not name', async () => {
    const api = await serve((_request, response) => json(response, 200, { data: [] }));
    const result = await listModels(chatQuery(), orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch() });
    expect(result.models).toEqual([]);
    expect(result.degraded).toBe(false);
  });
});

describe('capability filters', () => {
  it('keeps a chat model only when it declares a chat endpoint type', () => {
    const records: CatalogModel[] = [
      { id: 'a', endpointTypes: ['openai'], inputModalities: [] },
      { id: 'b', endpointTypes: ['anthropic'], inputModalities: [] },
      { id: 'c', endpointTypes: ['gemini'], inputModalities: [] },
      { id: 'd', endpointTypes: ['openai-response'], inputModalities: [] },
      { id: 'e', endpointTypes: ['image-generation'], inputModalities: [] },
      { id: 'f', endpointTypes: [], inputModalities: [] },
    ];
    expect(selectModels(records, chatQuery()).map((model) => model.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(CHAT_ENDPOINT_TYPES).toEqual(['openai', 'anthropic', 'gemini', 'openai-response']);
  });

  it('fails closed on multimodal: a chat model that does not declare image input is not offered', () => {
    const records: CatalogModel[] = [
      { id: 'text-only', endpointTypes: ['openai'], inputModalities: ['text'] },
      { id: 'vision', endpointTypes: ['openai'], inputModalities: ['text', 'image'] },
      { id: 'undeclared', endpointTypes: ['openai'], inputModalities: [] },
      { id: 'image-only', endpointTypes: ['image-generation'], inputModalities: ['image'] },
    ];
    expect(selectModels(records, chatQuery()).map((model) => model.id)).toEqual(['text-only', 'vision', 'undeclared']);
    expect(selectModels(records, { capability: 'chat', endpointTypes: CHAT_ENDPOINT_TYPES, inputModalities: ['image'] }).map((model) => model.id)).toEqual(['vision']);
  });

  it('filters each other capability by its own endpoint type', () => {
    const records: CatalogModel[] = [
      { id: 'chat', endpointTypes: ['openai'], inputModalities: [] },
      { id: 'embed', endpointTypes: ['embeddings'], inputModalities: [] },
      { id: 'image', endpointTypes: ['image-generation'], inputModalities: [] },
      { id: 'video', endpointTypes: ['openai-video'], inputModalities: [] },
      { id: 'rerank', endpointTypes: ['jina-rerank'], inputModalities: [] },
    ];
    expect(selectModels(records, embeddingQuery()).map((model) => model.id)).toEqual(['embed']);
    expect(selectModels(records, imageQuery()).map((model) => model.id)).toEqual(['image']);
    expect(selectModels(records, videoQuery()).map((model) => model.id)).toEqual(['video']);
    expect(selectModels(records, rerankQuery()).map((model) => model.id)).toEqual(['rerank']);
  });

  it('drops an endpoint type the client cannot speak instead of offering it', async () => {
    const api = await serve((_request, response) => json(response, 200, LIVE));
    const result = await listModels(chatQuery(), orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch() });
    expect(result.models.map((model) => model.id)).not.toContain('vendor/unknown-endpoint');
    expect(result.models.every((model) => model.endpointTypes.every((type) => CHAT_ENDPOINT_TYPES.includes(type as (typeof CHAT_ENDPOINT_TYPES)[number])))).toBe(true);
  });
});

describe('bounded reading', () => {
  it('refuses a body larger than the byte cap', async () => {
    const api = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: Array.from({ length: 50 }, (_, index) => ({ id: `m/${index}`, supported_endpoint_types: ['openai'] })) }));
    });
    const result = await listModels(chatQuery(), orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch(), maxBytes: 200 });
    expect(result.degraded).toBe(true);
    expect(result.reason).toMatch(/larger than 200 bytes/u);
  });

  it('caps the number of records it accepts', async () => {
    const api = await serve((_request, response) => json(response, 200, { data: Array.from({ length: 20 }, (_, index) => ({ id: `m/${index}`, supported_endpoint_types: ['openai'] })) }));
    const result = await listModels(chatQuery(), orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch(), maxItems: 3 });
    expect(result.models).toHaveLength(3);
  });

  it('falls back rather than hanging when the catalog does not answer', async () => {
    const api = await serve((_request, response) => json(response, 503, { error: 'unavailable' }));
    const result = await listModels(chatQuery(), orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch() });
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('503');
  });
});

describe('the verified fallback', () => {
  async function degraded(): Promise<Awaited<ReturnType<typeof listModels>>> {
    const api = await serve((_request, response) => json(response, 500, { error: 'down' }));
    return listModels(chatQuery(), orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch() });
  }

  it('stands in only when discovery fails, and is marked degraded with a reason', async () => {
    const result = await degraded();
    expect(result.degraded).toBe(true);
    expect(result.reason).toBeDefined();
    expect(result.models.map((model) => model.id)).toEqual(['orcarouter/auto', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash-vision-exp']);
  });

  it('carries only ids and capabilities observed in the live catalog, with no invented reasoning ladder', () => {
    for (const model of VERIFIED_FALLBACK_CATALOG) {
      expect(model.id).toMatch(/^(orcarouter|deepseek)\//u);
      expect(model.endpointTypes.length).toBeGreaterThan(0);
    }
    // The endpoint advertises no reasoning-effort field, so nothing claims one.
    expect(JSON.stringify(VERIFIED_FALLBACK_CATALOG)).not.toMatch(/reasoning|xhigh/iu);
    expect(VERIFIED_FALLBACK_CATALOG.find((model) => model.id === 'deepseek/deepseek-v4-pro')!.contextLength).toBe(1_048_576);
  });

  it('does not merge the seed into a successful live answer', async () => {
    const api = await serve((_request, response) => json(response, 200, { data: [{ id: 'vendor/only-live-model', supported_endpoint_types: ['openai'] }] }));
    const result = await listModels(chatQuery(), orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch() });
    expect(result.degraded).toBe(false);
    expect(result.models.map((model) => model.id)).toEqual(['vendor/only-live-model']);
    expect(result.models.map((model) => model.id)).not.toContain('orcarouter/auto');
  });

  it('answers a vision query from the seed with only the model that declares image input', async () => {
    const api = await serve((_request, response) => json(response, 500, { error: 'down' }));
    const result = await listModels({ capability: 'chat', endpointTypes: CHAT_ENDPOINT_TYPES, inputModalities: ['image'] }, orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch() });
    expect(result.degraded).toBe(true);
    expect(result.models.map((model) => model.id)).toEqual(['deepseek/deepseek-v4-flash-vision-exp']);
  });
});

describe('the e2e models listing', () => {
  it('describes each live model for a terminal', async () => {
    const api = await serve((_request, response) => json(response, 200, LIVE));
    const models = await describeModels(orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch() });
    expect(models).toMatchObject([
      { id: 'orcarouter/auto', detail: 'openai/openai-response/anthropic/gemini' },
      { id: 'deepseek/deepseek-v4-pro', detail: 'openai/openai-response, 1,048,576 ctx' },
      { id: 'deepseek/deepseek-v4-flash-vision-exp', detail: 'openai/openai-response/anthropic, 1,048,576 ctx, vision' },
    ]);
  });

  it('says plainly when the list is not the live one', async () => {
    const api = await serve((_request, response) => json(response, 500, { error: 'down' }));
    const models = await describeModels(orcaRouterOrigins({ ORCA_API_BASE_URL: `${api.url}/v1` }), { fetch: listingFetch() });
    expect(models[0]!.id).toContain('live catalog unavailable');
    expect(models.map((model) => model.id)).toContain('orcarouter/auto');
  });
});
