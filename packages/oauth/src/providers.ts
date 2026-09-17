/** The built-in providers by id, and the login options each one takes. */

import { createCodexProvider, type CodexLoginOptions } from './providers/openai-codex.ts';
import { createCopilotProvider, type CopilotLoginOptions } from './providers/github-copilot.ts';
import { createXaiProvider } from './providers/xai.ts';
import type { OAuthProvider } from './types.ts';

export interface LoginOptionsById {
  readonly 'openai-codex': CodexLoginOptions;
  readonly 'github-copilot': CopilotLoginOptions;
  readonly xai: Record<string, never>;
}

export type ProviderId = keyof LoginOptionsById;

export const PROVIDER_IDS = ['openai-codex', 'github-copilot', 'xai'] as const satisfies readonly ProviderId[];

// Method shorthand is bivariant, so each specialised provider fits the base interface without a cast.
const PROVIDERS: Record<ProviderId, OAuthProvider> = {
  'openai-codex': createCodexProvider(),
  'github-copilot': createCopilotProvider(),
  xai: createXaiProvider(),
};

export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

export function getProvider(id: ProviderId): OAuthProvider {
  return PROVIDERS[id];
}

export const USER_AGENT = 'e2e-oauth';

/** How a missing login is described to the user: the CLI command that fixes it. */
export function loginHint(id: ProviderId): string {
  return `run \`e2e login ${id}\` (or \`npx e2e-oauth login ${id}\`)`;
}
