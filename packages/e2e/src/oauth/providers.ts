/** The built-in providers by id, and the login options each one takes. */

import { packageVersion } from '../internal/package-version.ts';
import { createCodexProvider, type CodexLoginOptions } from './providers/openai.ts';
import { createCopilotProvider, type CopilotLoginOptions } from './providers/github-copilot.ts';
import { createApiKeyProvider, createAuthProvider } from './providers/orcarouter.ts';
import { createXaiProvider } from './providers/xai.ts';
import type { OAuthProvider } from './types.ts';

export interface LoginOptionsById {
  readonly openai: CodexLoginOptions;
  readonly 'github-copilot': CopilotLoginOptions;
  readonly spacexai: Record<string, never>;
  /** OrcaRouter reached with a key the user pastes, or the one in ORCAROUTER_API_KEY. */
  readonly orcarouter: Record<string, never>;
  /** OrcaRouter reached by authorizing in a browser, which mints a key of its own. */
  readonly 'orcarouter-oauth': Record<string, never>;
}

export type ProviderId = keyof LoginOptionsById;

export const PROVIDER_IDS = ['openai', 'github-copilot', 'spacexai', 'orcarouter', 'orcarouter-oauth'] as const satisfies readonly ProviderId[];

// Method shorthand is bivariant, so each specialised provider fits the base interface without a cast.
const PROVIDERS: Record<ProviderId, OAuthProvider> = {
  openai: createCodexProvider(),
  'github-copilot': createCopilotProvider(),
  spacexai: createXaiProvider(),
  orcarouter: createApiKeyProvider(),
  'orcarouter-oauth': createAuthProvider(),
};

export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

export function getProvider(id: ProviderId): OAuthProvider {
  return PROVIDERS[id];
}

/**
 * How requests identify this harness to a vendor: `e2e/<version> (<platform>; <arch>)`,
 * alongside the `originator` (ChatGPT) and `referrer` (SpaceXAI) the flows send. Never another client's name.
 */
export const USER_AGENT = `e2e/${packageVersion(import.meta.url, '../../package.json', '0.0.0')} (${process.platform}; ${process.arch})`;

/** How a missing login is described to the user: the CLI command that fixes it. */
export function loginHint(id: ProviderId): string {
  return `run \`npx e2e login ${id}\``;
}
