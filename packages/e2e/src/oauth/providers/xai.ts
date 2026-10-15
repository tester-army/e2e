/**
 * SuperGrok and X Premium+ through SpaceXAI's OAuth server. SpaceXAI publishes RFC 8628
 * device authorization for the Grok CLI's public client; the token is a plain
 * bearer against the ordinary SpaceXAI API. Refresh tokens rotate, so a renewed
 * refresh token replaces the stored one at once.
 */

import { z } from 'zod';
import { rfc8628Flow } from '../device-code.ts';
import { OAuthError, describeResponse, readJsonBody } from '../errors.ts';
import { decodeJwtPayload } from '../jwt.ts';
import { expiryFrom, requestTokens, type TokenResponse } from '../token-endpoint.ts';
import type { FetchFunction, OAuthCredentials, OAuthProvider, SubscriptionModel } from '../types.ts';

/** The public OAuth client of the Grok CLI, which third-party harnesses sign in through. */
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const ISSUER = 'https://auth.x.ai';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const MODELS_URL = 'https://api.x.ai/v1/language-models';

export interface XaiProviderOptions {
  /** The `referrer` the device request names: your product. */
  readonly referrer?: string;
  /** Test seam. */
  readonly issuer?: string;
  /** Test seam. */
  readonly modelsUrl?: string;
}

export function createXaiProvider(options: XaiProviderOptions = {}): OAuthProvider<OAuthCredentials, Record<string, never>> {
  const issuer = options.issuer ?? ISSUER;
  const referrer = options.referrer ?? 'e2e';
  const modelsUrl = options.modelsUrl ?? MODELS_URL;
  return {
    id: 'spacexai',
    name: 'SpaceXAI',
    async login(callbacks) {
      const tokens = await rfc8628Flow({
        vendor: 'SpaceXAI',
        deviceCodeUrl: `${issuer}/oauth2/device/code`,
        tokenUrl: `${issuer}/oauth2/token`,
        clientId: CLIENT_ID,
        request: { scope: SCOPE, referrer },
        callbacks,
      });
      return toCredentials(tokens, '');
    },
    async refresh(credentials) {
      const tokens = await requestTokens(
        'SpaceXAI',
        `${issuer}/oauth2/token`,
        { grant_type: 'refresh_token', refresh_token: credentials.refresh, client_id: CLIENT_ID },
        'LOGIN_REQUIRED',
      );
      return toCredentials(tokens, credentials.refresh);
    },
    models(fetch) {
      return listXaiModels(fetch, modelsUrl);
    },
  };
}

/** One entry of SpaceXAI's language-model list, as far as the listing reads it; a field of another type reads as absent. */
const XaiModelSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.unknown()).optional().catch(undefined),
  input_modalities: z.array(z.unknown()).optional().catch(undefined),
});

/** One of the two keys SpaceXAI lists models under; an entry that does not fit reads as `undefined`. */
const XaiModelsSchema = z.array(XaiModelSchema.optional().catch(undefined)).nullish();

/** The models in SpaceXAI's list body, under `models` or `data`; a body that names none has none, and an entry without an id is left out. */
const XaiModelListSchema = z
  .object({ models: XaiModelsSchema, data: XaiModelsSchema })
  .transform(({ models, data }) => (models ?? data ?? []).filter((model) => model !== undefined));

/** The language models the subscription's token reaches; aliases are listed with their target. */
async function listXaiModels(fetch: FetchFunction, url: string): Promise<SubscriptionModel[]> {
  const response = await fetch(url);
  if (!response.ok) throw new OAuthError('FLOW_FAILED', `SpaceXAI did not list its models: ${await describeResponse(response)}`);
  const models = await readJsonBody(response, XaiModelListSchema, 'the SpaceXAI model list');
  return models.map((model) => {
    const aliases = (model.aliases ?? []).filter((alias) => typeof alias === 'string');
    const detail = [
      model.input_modalities?.includes('image') === true ? 'vision' : undefined,
      aliases.length === 0 ? undefined : `also ${aliases.join(', ')}`,
    ].filter((part) => part !== undefined);
    return { id: model.id, ...(detail.length === 0 ? {} : { detail: detail.join('; ') }) };
  });
}

/** Expiry from the JWT when it carries one, else from `expires_in`; a refresh without a new refresh token keeps the old one. */
function toCredentials(tokens: TokenResponse, previousRefresh: string): OAuthCredentials {
  const exp = decodeJwtPayload(tokens.access_token)?.['exp'];
  const expires = typeof exp === 'number' && exp > 0 ? exp * 1000 : expiryFrom(tokens.expires_in);
  return { access: tokens.access_token, refresh: tokens.refresh_token ?? previousRefresh, expires };
}
