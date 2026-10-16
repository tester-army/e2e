/**
 * OpenCode Zen and Go through an OpenCode Console sign-in. Console speaks RFC
 * 8628 device authorization; approving the code binds the login to one
 * workspace, and its token is a bearer for both the Console API and inference.
 * Refresh tokens rotate. The workspace config says which models are served and
 * over which protocol: Zen is its `opencode` provider, Go `opencode-go`, present
 * only for the Go subscriber. Go ids take a `go/` prefix here.
 */

import { z } from 'zod';
import { rfc8628Flow } from '../device-code.ts';
import { OAuthError, describeResponse, readJsonBody } from '../errors.ts';
import { expiryFrom, requestTokens, type TokenResponse } from '../token-endpoint.ts';
import type { FetchFunction, OAuthCredentials, OAuthProvider, SubscriptionModel } from '../types.ts';

/** Console accepts any client id. */
const CLIENT_ID = 'e2e';
const CONSOLE_URL = 'https://opencode.ai/console';
const INFERENCE_URL = 'https://opencode.ai/inference';
const GO_PREFIX = 'go/';
const ZEN_PROVIDER = 'opencode';
const GO_PROVIDER = 'opencode-go';

export interface OpencodeConsoleCredentials extends OAuthCredentials {
  /** The workspace the login is bound to; absent for a service API key. */
  readonly orgId?: string;
}

export interface OpencodeConsoleProviderOptions {
  /** Test seam. */
  readonly consoleUrl?: string;
}

export function createOpencodeConsoleProvider(options: OpencodeConsoleProviderOptions = {}): OAuthProvider<OpencodeConsoleCredentials, Record<string, never>> {
  const consoleUrl = options.consoleUrl ?? CONSOLE_URL;
  const tokenUrl = `${consoleUrl}/auth/device/token`;
  return {
    id: 'opencode-console',
    name: 'OpenCode Console',
    apiKeyEnv: 'OPENCODE_API_KEY',
    async login(callbacks) {
      const deviceCodeUrl = `${consoleUrl}/auth/device/code`;
      const tokens = await rfc8628Flow({
        vendor: 'OpenCode Console',
        deviceCodeUrl,
        tokenUrl,
        clientId: CLIENT_ID,
        request: { supports_org_scope: 'true' },
        // Console answers with a relative verification URL.
        callbacks: {
          ...callbacks,
          onAuth: (info) => {
            const url = new URL(info.url, deviceCodeUrl).href;
            callbacks.onAuth({
              ...info,
              url,
              instructions: `Open ${url} on any device, pick the workspace to sign in to${info.userCode === undefined ? '' : `, and confirm the code ${info.userCode}`}.`,
            });
          },
        },
      });
      return toCredentials(tokens);
    },
    async refresh(credentials) {
      if (credentials.refresh === '') throw new OAuthError('LOGIN_REQUIRED', 'OpenCode Console has no refresh token for this login');
      const tokens = await requestTokens(
        'OpenCode Console',
        tokenUrl,
        { grant_type: 'refresh_token', refresh_token: credentials.refresh, client_id: CLIENT_ID },
        'LOGIN_REQUIRED',
      );
      return toCredentials(tokens, credentials);
    },
    send(request, credentials, upstream) {
      return sendOpencodeConsoleRequest(request, credentials, upstream, consoleUrl);
    },
    models(fetch) {
      return listOpencodeConsoleModels(fetch, consoleUrl);
    },
  };
}

/** Names the workspace as each API expects, and drops the Google SDK's placeholder key header. */
async function sendOpencodeConsoleRequest(request: Request, credentials: OpencodeConsoleCredentials, upstream: FetchFunction, consoleUrl: string): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('x-goog-api-key');
  if (credentials.orgId !== undefined) headers.set(request.url.startsWith(`${consoleUrl}/`) ? 'x-org-id' : 'x-opencode-org-id', credentials.orgId);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  return upstream(new Request(request.url, { method: request.method, headers, signal: request.signal, ...(body === undefined ? {} : { body }) }));
}

/** The npm package and base URL a provider or one of its models is served through; a field of another type reads as absent. */
const ConfigRouteSchema = z.object({
  npm: z.string().optional().catch(undefined),
  api: z.string().optional().catch(undefined),
});

/** One model of a workspace provider, as far as routing and the listing read it; a field of another type reads as absent. */
const ConfigModelSchema = z.object({
  id: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  disabled: z.unknown().optional(),
  cost: z.object({ input: z.number().optional().catch(undefined), output: z.number().optional().catch(undefined) }).optional().catch(undefined),
  modalities: z.object({ input: z.array(z.unknown()).optional().catch(undefined) }).optional().catch(undefined),
  provider: ConfigRouteSchema.optional().catch(undefined),
});

type ConfigModel = z.infer<typeof ConfigModelSchema>;

/** One provider of the workspace config; a model that is not an object is left out. */
const ConfigProviderSchema = ConfigRouteSchema.extend({
  models: z.record(z.string(), ConfigModelSchema.optional().catch(undefined)).optional().catch(undefined),
});

/** The providers of the Console's `/api/config` body by id; a body that names none has none, and a provider that is not an object is left out. */
const ConfigSchema = z
  .object({ config: z.object({ provider: z.record(z.string(), ConfigProviderSchema.optional().catch(undefined)).nullish() }).nullish() })
  .transform(({ config }) => config?.provider ?? {});

type ConfigProviders = z.infer<typeof ConfigSchema>;

async function readConfig(fetch: FetchFunction, consoleUrl: string, signal?: AbortSignal): Promise<ConfigProviders> {
  const response = await fetch(new Request(`${consoleUrl}/api/config`, signal === undefined ? {} : { signal }));
  if (!response.ok) throw new OAuthError('FLOW_FAILED', `OpenCode Console did not return the workspace config: ${await describeResponse(response)}`);
  return readJsonBody(response, ConfigSchema, 'the OpenCode Console workspace config');
}

/** Leaves out disabled models and Zen's free ones, which only OpenCode's own clients may use. */
async function listOpencodeConsoleModels(fetch: FetchFunction, consoleUrl: string): Promise<SubscriptionModel[]> {
  const providers = await readConfig(fetch, consoleUrl);
  const listed = (key: string, prefix: string, plan: string) =>
    Object.entries(providers[key]?.models ?? {}).flatMap(([id, model]): SubscriptionModel[] => {
      if (model === undefined || model.disabled === true || (key !== GO_PROVIDER && isFree(model))) return [];
      const detail = [
        plan,
        model.cost?.input !== undefined && model.cost.output !== undefined && key === ZEN_PROVIDER ? `$${model.cost.input} in, $${model.cost.output} out per 1M` : undefined,
        model.modalities?.input?.includes('image') === true ? 'vision' : undefined,
      ].filter((part) => part !== undefined);
      return [{ id: `${prefix}${id}`, ...(model.name === undefined || model.name === '' ? {} : { name: model.name }), detail: detail.join(', ') }];
    });
  return [...listed(ZEN_PROVIDER, '', 'Zen'), ...listed(GO_PROVIDER, GO_PREFIX, 'Go')];
}

function isFree(model: ConfigModel): boolean {
  return model.cost?.input === 0 && model.cost.output === 0;
}

export interface OpencodeConsoleRoute {
  readonly go: boolean;
  readonly npm: string;
  readonly baseURL: string;
  readonly modelId: string;
}

const CHAT_NPM = '@ai-sdk/openai-compatible';

function splitModelId(modelId: string): { readonly go: boolean; readonly id: string } {
  const go = modelId.startsWith(GO_PREFIX);
  return { go, id: go ? modelId.slice(GO_PREFIX.length) : modelId };
}

/** The plan's chat completions route, used until the config is read. */
export function opencodeConsoleChatRoute(modelId: string): OpencodeConsoleRoute {
  const { go, id } = splitModelId(modelId);
  return { go, npm: CHAT_NPM, baseURL: `${INFERENCE_URL}${go ? '/go' : ''}/openai/v1`, modelId: id };
}

/**
 * The model's route from the workspace config, or `undefined` when the config
 * could not be read, so the caller asks again rather than remembering a guess.
 */
export async function opencodeConsoleRouteFor(modelId: string, fetch: FetchFunction, signal: AbortSignal): Promise<OpencodeConsoleRoute | undefined> {
  let providers: ConfigProviders;
  try {
    providers = await readConfig(fetch, CONSOLE_URL, signal);
  } catch (error) {
    if (error instanceof OAuthError && error.code !== 'FLOW_FAILED') throw error;
    return undefined;
  }
  const { go, id } = splitModelId(modelId);
  const provider = providers[go ? GO_PROVIDER : ZEN_PROVIDER];
  if (provider === undefined) {
    throw new OAuthError(
      'MISCONFIGURED',
      go
        ? 'OpenCode Go is not available to this login: the workspace has no Go subscription, or the signed-in user is not its subscriber; sign in to the Go workspace with `npx e2e login opencode-console`'
        : 'OpenCode Zen is turned off for this OpenCode Console workspace',
    );
  }
  const model = provider.models?.[id];
  if (model === undefined || model.disabled === true) {
    throw new OAuthError('MISCONFIGURED', `the OpenCode Console workspace does not serve ${modelId}; \`npx e2e models opencode-console\` lists the ids`);
  }
  const npm = model.provider?.npm ?? provider.npm;
  const baseURL = model.provider?.api ?? provider.api;
  if (npm === undefined || baseURL === undefined) return undefined;
  return { go, npm, baseURL, modelId: model.id === undefined || model.id === '' ? id : model.id };
}

/** A refresh keeps the workspace and the refresh token when the grant omits them. */
function toCredentials(tokens: TokenResponse, previous?: OpencodeConsoleCredentials): OpencodeConsoleCredentials {
  const orgId = tokens['org_id'];
  const workspace = typeof orgId === 'string' && orgId !== '' ? orgId : previous?.orgId;
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? previous?.refresh ?? '',
    expires: expiryFrom(tokens.expires_in),
    ...(workspace === undefined ? {} : { orgId: workspace }),
  };
}
