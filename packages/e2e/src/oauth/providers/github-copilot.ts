/**
 * GitHub Copilot. The Copilot API accepts a GitHub sign-in as the bearer, so
 * the login is either the token the GitHub CLI already holds or GitHub's
 * device flow (RFC 8628) for an OAuth App you register. GitHub user tokens do
 * not expire; a 401 means signing in again.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { rfc8628Flow } from '../device-code.ts';
import { OAuthError, describeResponse, readJsonBody } from '../errors.ts';
import type { FetchFunction, OAuthCredentials, OAuthProvider, SubscriptionModel } from '../types.ts';

const execFileAsync = promisify(execFile);

export interface CopilotLoginOptions {
  /**
   * The client id of your GitHub OAuth App with the device flow enabled.
   * Without one, the login reuses the GitHub CLI's token when `gh` is signed in.
   */
  readonly clientId?: string;
  /** Reuse `gh auth token` even when a client id is given. */
  readonly fromGitHubCli?: boolean;
  /** `github.example.com` for GitHub Enterprise; Copilot then lives at `copilot-api.github.example.com`. */
  readonly enterpriseUrl?: string;
}

export interface CopilotCredentials extends OAuthCredentials {
  readonly enterpriseUrl?: string;
}

export interface CopilotProviderOptions {
  /** Test seams: the GitHub host the device flow talks to, and how the GitHub CLI's token is read. */
  readonly githubUrl?: string;
  readonly githubCliToken?: (hostname: string | undefined) => Promise<string | undefined>;
}

export const COPILOT_API_URL = 'https://api.githubcopilot.com';

/**
 * The bare host of a GitHub Enterprise URL. The bearer token goes to a host
 * derived from it, so anything besides a plain hostname (credentials, a path,
 * a query, a fragment, a port) is refused rather than guessed at.
 */
export function enterpriseHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new OAuthError('MISCONFIGURED', `${value} is not a GitHub Enterprise host; pass the hostname, e.g. github.example.com`);
  }
  const plain =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '' &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(url.hostname);
  if (!plain) throw new OAuthError('MISCONFIGURED', `${value} is not a GitHub Enterprise host; pass the hostname, e.g. github.example.com`);
  return url.hostname.toLowerCase();
}

/** The Copilot API base for github.com or an enterprise host. */
export function copilotBaseUrl(enterpriseUrl?: string): string {
  return enterpriseUrl === undefined || enterpriseUrl === '' ? COPILOT_API_URL : `https://copilot-api.${enterpriseHost(enterpriseUrl)}`;
}

export function createCopilotProvider(options: CopilotProviderOptions = {}): OAuthProvider<CopilotCredentials, CopilotLoginOptions> {
  const cliToken = options.githubCliToken ?? githubCliToken;
  return {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    async login(callbacks, loginOptions = {}) {
      const enterprise = loginOptions.enterpriseUrl === undefined ? undefined : enterpriseHost(loginOptions.enterpriseUrl);
      const stored = enterprise === undefined ? {} : { enterpriseUrl: enterprise };
      if (loginOptions.clientId !== undefined && loginOptions.fromGitHubCli !== true) {
        const tokens = await rfc8628Flow({
          vendor: 'GitHub',
          deviceCodeUrl: `${options.githubUrl ?? `https://${enterprise ?? 'github.com'}`}/login/device/code`,
          tokenUrl: `${options.githubUrl ?? `https://${enterprise ?? 'github.com'}`}/login/oauth/access_token`,
          clientId: loginOptions.clientId,
          request: { scope: 'read:user' },
          callbacks,
        });
        return { access: tokens.access_token, refresh: '', expires: 0, ...stored };
      }
      const token = await cliToken(enterprise);
      if (token === undefined) {
        throw new OAuthError(
          'MISCONFIGURED',
          'GitHub Copilot login needs either the GitHub CLI signed in (gh auth login) or the client id of a GitHub OAuth App with the device flow enabled',
        );
      }
      callbacks.onProgress?.('Using the GitHub CLI token');
      return { access: token, refresh: '', expires: 0, ...stored };
    },
    async refresh() {
      throw new OAuthError('LOGIN_REQUIRED', 'GitHub rejected the Copilot token');
    },
    send(request, credentials, upstream) {
      return sendCopilotRequest(request, credentials, upstream);
    },
    models(fetch) {
      return listCopilotModels(fetch);
    },
  };
}

async function githubCliToken(hostname: string | undefined): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', ...(hostname === undefined ? [] : ['--hostname', hostname])], { timeout: 10_000 });
    return stdout.trim() === '' ? undefined : stdout.trim();
  } catch {
    return undefined;
  }
}

/** Routes an enterprise login at its host and adds Copilot's headers: who initiated the turn, and that images are present. */
export async function sendCopilotRequest(request: Request, credentials: CopilotCredentials, upstream: FetchFunction): Promise<Response> {
  const url = new URL(request.url);
  if (credentials.enterpriseUrl !== undefined && url.origin === COPILOT_API_URL) url.host = new URL(copilotBaseUrl(credentials.enterpriseUrl)).host;
  const headers = new Headers(request.headers);
  headers.set('openai-intent', 'conversation-edits');
  const text = request.method === 'POST' ? await request.text() : undefined;
  const turn = copilotTurn(text);
  headers.set('x-initiator', turn.initiator);
  if (turn.vision) headers.set('copilot-vision-request', 'true');
  return upstream(new Request(url, { method: request.method, headers, signal: request.signal, ...(text === undefined ? {} : { body: text }) }));
}

/** One turn of either protocol, a chat `messages[]` entry or a Responses `input[]` item; one that is not an object reads as empty. */
const CopilotTurnSchema = z.object({ role: z.unknown().optional(), content: z.unknown().optional() }).catch({});

/** The turns of a chat or Responses body; a list of another type reads as absent. */
const CopilotBodySchema = z.object({
  messages: z.array(CopilotTurnSchema).optional().catch(undefined),
  input: z.array(CopilotTurnSchema).optional().catch(undefined),
});

/**
 * Reads who initiated the turn and whether images are present, whichever
 * protocol carried the body. Chat completions put turns in `messages[]` and
 * images in `image_url` parts; the Responses API puts them in `input[]` with
 * `input_image`. A body shaped like neither keeps the defaults.
 */
function copilotTurn(text: string | undefined): { initiator: 'user' | 'agent'; vision: boolean } {
  if (text === undefined) return { initiator: 'user', vision: false };
  try {
    const { messages, input } = CopilotBodySchema.parse(JSON.parse(text));
    // A Responses body has `input` and no `messages`; anything else stays on the chat path.
    if (messages === undefined && input !== undefined) {
      return { initiator: input.at(-1)?.role === 'user' ? 'user' : 'agent', vision: input.some((item) => hasPart(item.content, 'input_image')) };
    }
    const turns = messages ?? [];
    return { initiator: turns.at(-1)?.role === 'user' ? 'user' : 'agent', vision: turns.some((message) => hasPart(message.content, 'image_url')) };
  } catch {
    // Not a JSON object; the headers stay at their defaults.
    return { initiator: 'user', vision: false };
  }
}

/** Whether a turn's content carries a part of the given type (`image_url` for chat, `input_image` for Responses). */
function hasPart(content: unknown, type: string): boolean {
  return Array.isArray(content) && content.some((part: { type?: string }) => part?.type === type);
}

/** One entry of the Copilot API's `/models`, as far as the listing reads it; a field of another type reads as absent. */
const CopilotModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional().catch(undefined),
  vendor: z.string().optional().catch(undefined),
  preview: z.unknown().optional(),
  policy: z.object({ state: z.string().optional().catch(undefined) }).optional().catch(undefined),
  supported_endpoints: z.array(z.unknown()).optional().catch(undefined),
  capabilities: z
    .object({
      type: z.unknown().optional(),
      supports: z.object({ tool_calls: z.unknown().optional(), vision: z.unknown().optional() }).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

type CopilotModel = z.infer<typeof CopilotModelSchema>;

/** The models in a Copilot API `/models` body, `undefined` when it names none; an entry without an id is left out. */
const CopilotModelListSchema = z
  .object({ data: z.array(CopilotModelSchema.optional().catch(undefined)).nullish() })
  .transform(({ data }) => data?.filter((model) => model !== undefined));

/**
 * The chat models the Copilot plan serves; embeddings and other kinds are
 * left out because only chat models fit `copilot()`. A model it cannot call
 * at all is listed but marked: one the plan has not enabled, or one Copilot
 * serves only over APIs `copilot()` does not speak (such as Messages). The
 * request goes through `send`, so an enterprise login lists its own host.
 */
async function listCopilotModels(fetch: FetchFunction): Promise<SubscriptionModel[]> {
  const response = await fetch(`${COPILOT_API_URL}/models`);
  if (!response.ok) throw new OAuthError('FLOW_FAILED', `GitHub Copilot did not list its models: ${await describeResponse(response)}`);
  const models = (await readJsonBody(response, CopilotModelListSchema, 'the GitHub Copilot model list')) ?? [];
  return models
    .filter((model) => model.capabilities?.type === undefined || model.capabilities.type === 'chat')
    .map((model) => {
      const supports = model.capabilities?.supports;
      const detail = [
        model.vendor,
        supports?.tool_calls === true ? 'tools' : undefined,
        supports?.vision === true ? 'vision' : undefined,
        model.preview === true ? 'preview' : undefined,
        model.policy?.state !== undefined && model.policy.state !== 'enabled' ? 'not enabled' : undefined,
        copilotProtocol(model) === undefined ? 'no chat or responses' : undefined,
      ].filter((part) => part !== undefined);
      return {
        id: model.id,
        ...(model.name === undefined || model.name === '' ? {} : { name: model.name }),
        ...(detail.length === 0 ? {} : { detail: detail.join(', ') }),
      };
    });
}

/** The endpoint `copilot()` reaches a Copilot chat model over: chat completions or the Responses API. */
export type CopilotProtocol = 'chat' | 'responses';

/**
 * Which endpoint `copilot()` reaches `modelId` on, read from the Copilot
 * API's `GET /models`, or `undefined` when the listing could not be read
 * (an error status, a body that is not JSON, the network, the signal), so
 * the caller can ask again instead of remembering a guess. A model the
 * listing does not name, or names with no endpoint `copilot()` speaks, is
 * chat: the vendor's own error then explains it. A rejected login is not a
 * missing listing and rejects.
 */
export async function copilotProtocolFor(modelId: string, fetch: FetchFunction, signal: AbortSignal): Promise<CopilotProtocol | undefined> {
  try {
    const response = await fetch(new Request(`${COPILOT_API_URL}/models`, { signal }));
    if (!response.ok) return undefined;
    const listing = CopilotModelListSchema.safeParse(await response.json());
    if (!listing.success || listing.data === undefined) return undefined;
    return copilotProtocol(listing.data.find((model) => model.id === modelId)) ?? 'chat';
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    return undefined;
  }
}

/**
 * The protocol one `/models` entry is served on, or `undefined` when
 * `copilot()` cannot call it. An entry that names no endpoints is chat, as
 * Copilot's older models are; chat completions wins when both are named, so
 * a model that worked over chat keeps doing so. Whether the plan enabled the
 * model is a separate question: Copilot rejects a disabled model the same
 * way on either endpoint.
 */
function copilotProtocol(model: CopilotModel | undefined): CopilotProtocol | undefined {
  const endpoints = model?.supported_endpoints;
  if (model === undefined || !Array.isArray(endpoints)) return 'chat';
  if (endpoints.includes('/chat/completions')) return 'chat';
  if (endpoints.includes('/responses')) return 'responses';
  return undefined;
}

/** Why `modelId` cannot be used, as the run error reads it, once Copilot answered `model_not_supported`. */
export function copilotRefusal(modelId: string): string {
  return `GitHub Copilot does not serve ${modelId} to this account: the plan does not include it, it is turned off in Copilot settings on GitHub, or Copilot lists no such id; npx e2e models github-copilot lists the ids, and the listing cannot see plan limits`;
}

/** True for the AI SDK's error over a 4xx whose body code is `model_not_supported`; a wrong endpoint (`unsupported_api_for_model`) is not this. */
export function isCopilotRefusal(cause: unknown): cause is Error {
  if (!(cause instanceof Error) || cause.name !== 'AI_APICallError') return false;
  const { statusCode, data, responseBody } = cause as { statusCode?: unknown; data?: unknown; responseBody?: unknown };
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) return false;
  const parsed = data ?? (typeof responseBody === 'string' ? parseJson(responseBody) : undefined);
  return (parsed as { error?: { code?: unknown } } | undefined)?.error?.code === 'model_not_supported';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
