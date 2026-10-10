/**
 * OpenCode Zen and Go through an OpenCode Console sign-in. Console speaks RFC
 * 8628 device authorization; approving the code binds the login to one
 * workspace, and its token is a bearer for both the Console API and inference.
 * Refresh tokens rotate. The workspace config says which models are served and
 * over which protocol: Zen is its `opencode` provider, Go `opencode-go`, present
 * only for the Go subscriber. Go ids take a `go/` prefix here.
 */

import { rfc8628Flow } from '../device-code.ts';
import { OAuthError, describeResponse } from '../errors.ts';
import { EnvCredentialStore } from '../store.ts';
import { expiryFrom, requestTokens, type TokenResponse } from '../token-endpoint.ts';
import type { CredentialStore, FetchFunction, OAuthCredentials, OAuthProvider, SubscriptionModel } from '../types.ts';

/** Console accepts any client id. */
const CLIENT_ID = 'e2e';
const CONSOLE_URL = 'https://opencode.ai/console';
const INFERENCE_URL = 'https://opencode.ai/inference';

const GO_PREFIX = 'go/';
const ZEN_PROVIDER = 'opencode';
const GO_PROVIDER = 'opencode-go';

/** The service account key that stands in for a stored Console login. */
export const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY';

/** A Console service API key as a login with nothing to refresh. */
export function opencodeConsoleApiKeyStore(apiKey: string): CredentialStore {
  return new EnvCredentialStore(JSON.stringify({ 'opencode-console': { access: apiKey, refresh: '', expires: 0 } }));
}

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

interface ConfigModel {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly disabled?: unknown;
  readonly cost?: { readonly input?: unknown; readonly output?: unknown };
  readonly modalities?: { readonly input?: unknown };
  readonly provider?: { readonly npm?: unknown; readonly api?: unknown };
}

interface ConfigProvider {
  readonly npm?: unknown;
  readonly api?: unknown;
  readonly models?: Readonly<Record<string, ConfigModel>>;
}

type ConfigProviders = Readonly<Record<string, ConfigProvider | undefined>>;

async function readConfig(fetch: FetchFunction, consoleUrl: string, signal?: AbortSignal): Promise<ConfigProviders> {
  const response = await fetch(new Request(`${consoleUrl}/api/config`, signal === undefined ? {} : { signal }));
  if (!response.ok) throw new OAuthError('FLOW_FAILED', `OpenCode Console did not return the workspace config: ${await describeResponse(response)}`);
  const payload = (await response.json()) as { config?: { provider?: unknown } };
  const providers = payload.config?.provider;
  return typeof providers === 'object' && providers !== null ? (providers as ConfigProviders) : {};
}

/** Leaves out disabled models and Zen's free ones, which only OpenCode's own clients may use. */
async function listOpencodeConsoleModels(fetch: FetchFunction, consoleUrl: string): Promise<SubscriptionModel[]> {
  const providers = await readConfig(fetch, consoleUrl);
  const listed = (key: string, prefix: string, plan: string) =>
    Object.entries(providers[key]?.models ?? {})
      .filter(([, model]) => model.disabled !== true && (key === GO_PROVIDER || !isFree(model)))
      .map(([id, model]): SubscriptionModel => {
        const detail = [
          plan,
          typeof model.cost?.input === 'number' && typeof model.cost.output === 'number' && key === ZEN_PROVIDER ? `$${model.cost.input} in, $${model.cost.output} out per 1M` : undefined,
          Array.isArray(model.modalities?.input) && model.modalities.input.includes('image') ? 'vision' : undefined,
        ].filter((part) => part !== undefined);
        return { id: `${prefix}${id}`, ...(typeof model.name === 'string' && model.name !== '' ? { name: model.name } : {}), detail: detail.join(', ') };
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
  const npm = typeof model.provider?.npm === 'string' ? model.provider.npm : provider.npm;
  const baseURL = typeof model.provider?.api === 'string' ? model.provider.api : provider.api;
  if (typeof npm !== 'string' || typeof baseURL !== 'string') return undefined;
  return { go, npm, baseURL, modelId: typeof model.id === 'string' && model.id !== '' ? model.id : id };
}

/** A refresh keeps the workspace and the refresh token when the grant omits them. */
function toCredentials(tokens: TokenResponse, previous?: OpencodeConsoleCredentials): OpencodeConsoleCredentials {
  const orgId = (tokens as TokenResponse & { readonly org_id?: unknown }).org_id;
  const workspace = typeof orgId === 'string' && orgId !== '' ? orgId : previous?.orgId;
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? previous?.refresh ?? '',
    expires: expiryFrom(tokens.expires_in),
    ...(workspace === undefined ? {} : { orgId: workspace }),
  };
}
