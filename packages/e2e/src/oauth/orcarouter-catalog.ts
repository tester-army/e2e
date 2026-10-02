/**
 * The OrcaRouter model catalog: one bounded `GET /models` on the inference
 * origin, turned into options a model control can offer. The live answer is
 * the only source of truth; a small verified seed stands in when the catalog
 * cannot be read, is reported as degraded, and is never merged into a live
 * result.
 *
 * Every request goes through the credential-carrying fetch the caller hands
 * in. That matters: the endpoint answers a keyed request with the models the
 * account can actually call, and an unkeyed one with a much larger anonymous
 * browse list, so the key is what makes the answer authoritative.
 *
 * Capabilities are decided from the catalog's own metadata, never from a
 * model's name. A record that does not declare an endpoint type or an input
 * modality the caller needs is left out, so an undeclared capability fails
 * closed instead of putting a model in a dropdown that cannot serve it.
 */

import { describeResponse, OAuthError } from './errors.ts';
import { catalogUrl, type OrcaRouterOrigins } from './orcarouter-origins.ts';
import type { FetchFunction, SubscriptionModel } from './types.ts';

/** Endpoint types this client can speak. A record declaring none of them is not offered. */
export const CHAT_ENDPOINT_TYPES = ['openai', 'anthropic', 'gemini', 'openai-response'] as const;

/** Every endpoint type the client reads; an unknown one is dropped rather than guessed at. */
const KNOWN_ENDPOINT_TYPES = new Set<string>([
  ...CHAT_ENDPOINT_TYPES,
  'openai-video',
  'image-generation',
  'embeddings',
  'jina-rerank',
]);

const KNOWN_MODALITIES = new Set(['text', 'image', 'audio', 'video']);

/** One catalog record, kept to the fields a model control needs. */
export interface CatalogModel {
  readonly id: string;
  readonly name?: string;
  readonly contextLength?: number;
  readonly endpointTypes: readonly string[];
  readonly inputModalities: readonly string[];
}

/** What an entry point needs a model to be able to do. */
export interface CatalogQuery {
  /** Sent as the request's `capability` parameter when the API takes one. */
  readonly capability?: 'chat' | 'embedding' | 'image';
  /** The record must declare at least one of these endpoint types. */
  readonly endpointTypes: readonly string[];
  /** The record must declare every one of these input modalities. */
  readonly inputModalities?: readonly string[];
}

/** Text chat and agent `act`: a chat endpoint, no modality requirement. */
export function chatQuery(): CatalogQuery {
  return { capability: 'chat', endpointTypes: CHAT_ENDPOINT_TYPES };
}

/**
 * Multimodal understanding: a chat endpoint whose declared input modalities
 * include the image the agent actually uploads. An undeclared modality fails
 * closed, so a text-only model never appears in a vision dropdown.
 */
export function visionQuery(): CatalogQuery {
  return { capability: 'chat', endpointTypes: CHAT_ENDPOINT_TYPES, inputModalities: ['image'] };
}

export function embeddingQuery(): CatalogQuery {
  return { capability: 'embedding', endpointTypes: ['embeddings'] };
}

export function imageQuery(): CatalogQuery {
  return { capability: 'image', endpointTypes: ['image-generation'] };
}

/** Video generation: the endpoint type alone; the API publishes no capability name for it. */
export function videoQuery(): CatalogQuery {
  return { endpointTypes: ['openai-video'] };
}

/** Reranking: the endpoint type alone. */
export function rerankQuery(): CatalogQuery {
  return { endpointTypes: ['jina-rerank'] };
}

/**
 * The seed a fresh installation starts from when the catalog cannot be read.
 * Every id and every capability here was observed against the live
 * `GET https://api.orcarouter.ai/v1/models` (verification date 2026-10-02);
 * nothing is inferred from a model's name. The OpenAI, Anthropic, and Google
 * namespaces are absent on purpose: the live catalog advertises neither, so
 * there is no primary-source evidence they are callable, and `orcarouter/auto`
 * is the routing entry that serves any prompt in the meantime.
 */
export const VERIFIED_FALLBACK_CATALOG: readonly CatalogModel[] = [
  // The catalog declares no endpoint types or modalities for this entry either.
  { id: 'orcarouter/auto', endpointTypes: [...CHAT_ENDPOINT_TYPES], inputModalities: [] },
  { id: 'deepseek/deepseek-v4-pro', contextLength: 1_048_576, endpointTypes: ['openai', 'openai-response'], inputModalities: ['text'] },
  {
    id: 'deepseek/deepseek-v4-flash-vision-exp',
    contextLength: 1_048_576,
    endpointTypes: ['openai', 'openai-response', 'anthropic'],
    inputModalities: ['text', 'image'],
  },
];

export interface CatalogOptions {
  /**
   * The fetch the request goes through. It is required, not defaulted: the
   * catalog is per account, and an unauthenticated request answers a much
   * larger anonymous browse list rather than the models this user can call.
   */
  readonly fetch: FetchFunction;
  /** How long the catalog request may take. */
  readonly timeoutMs?: number;
  /** How many response bytes are read before the answer is refused. */
  readonly maxBytes?: number;
  /** How many records are accepted. */
  readonly maxItems?: number;
}

export interface CatalogResult {
  readonly models: readonly CatalogModel[];
  /** True when the live catalog could not be read and the verified seed answered instead. */
  readonly degraded: boolean;
  /** Why it is degraded, for a status line. Never carries a credential. */
  readonly reason?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ITEMS = 2_000;

/** Reads the catalog and filters it for one entry point; `degraded` when the seed answered. */
export async function listModels(query: CatalogQuery, origins: OrcaRouterOrigins, options: CatalogOptions): Promise<CatalogResult> {
  const params: Record<string, string> = query.capability === undefined ? {} : { capability: query.capability };
  let catalog: CatalogResult;
  try {
    catalog = { models: await readCatalog(catalogUrl(origins, params), options), degraded: false };
  } catch (cause) {
    return {
      models: selectModels(VERIFIED_FALLBACK_CATALOG, query),
      degraded: true,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return { ...catalog, models: selectModels(catalog.models, query) };
}

/** The models `e2e models orcarouter` prints: the text chat list, described for a terminal. */
export async function describeModels(origins: OrcaRouterOrigins, options: CatalogOptions): Promise<SubscriptionModel[]> {
  const result = await listModels(chatQuery(), origins, options);
  const models = result.models.map((model) => {
    const detail = [
      model.endpointTypes.length === 0 ? undefined : model.endpointTypes.join('/'),
      model.contextLength === undefined ? undefined : `${model.contextLength.toLocaleString('en-US')} ctx`,
      model.inputModalities.includes('image') ? 'vision' : undefined,
    ].filter((part) => part !== undefined);
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(detail.length === 0 ? {} : { detail: detail.join(', ') }),
    };
  });
  if (result.degraded) {
    // A degraded listing must never pass for the live one; the CLI prints this line above the models.
    models.unshift({ id: '(live catalog unavailable; showing the verified fallback)', detail: result.reason ?? '' });
  }
  return models;
}

/** Keeps the records that declare every capability the caller needs. */
export function selectModels(models: readonly CatalogModel[], query: CatalogQuery): CatalogModel[] {
  return models.filter((model) => {
    if (!query.endpointTypes.some((type) => model.endpointTypes.includes(type))) return false;
    return (query.inputModalities ?? []).every((modality) => model.inputModalities.includes(modality));
  });
}

/** The catalog as the API serves it: bounded, shape-checked, and never larger than `maxItems`. */
async function readCatalog(url: string, options: CatalogOptions): Promise<CatalogModel[]> {
  const { fetch } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new OAuthError('FLOW_FAILED', `OrcaRouter did not list its models: ${await describeResponse(response)}`);
  const text = await readBounded(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    throw new OAuthError('FLOW_FAILED', 'the OrcaRouter model catalog is not JSON', { cause });
  }
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new OAuthError('FLOW_FAILED', 'the OrcaRouter model catalog is missing a data array');
  const models: CatalogModel[] = [];
  for (const entry of data.slice(0, options.maxItems ?? DEFAULT_MAX_ITEMS)) {
    const model = parseModel(entry);
    if (model !== undefined) models.push(model);
  }
  return models;
}

/** One record, or nothing when it has no usable id. */
function parseModel(entry: unknown): CatalogModel | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id === '') return undefined;
  const endpointTypes = strings(record['supported_endpoint_types']).filter((type) => KNOWN_ENDPOINT_TYPES.has(type));
  const inputModalities = strings((record['architecture'] as { input_modalities?: unknown } | undefined)?.input_modalities).filter((modality) => KNOWN_MODALITIES.has(modality));
  const name = record['name'];
  const contextLength = record['context_length'];
  return {
    id,
    ...(typeof name === 'string' && name !== '' ? { name } : {}),
    ...(typeof contextLength === 'number' && Number.isFinite(contextLength) && contextLength > 0 ? { contextLength } : {}),
    endpointTypes,
    inputModalities,
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Reads at most `maxBytes` of the body; a promised larger body is refused before it is read. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new OAuthError('FLOW_FAILED', `the OrcaRouter model catalog is larger than ${maxBytes} bytes`);
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new OAuthError('FLOW_FAILED', `the OrcaRouter model catalog is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
