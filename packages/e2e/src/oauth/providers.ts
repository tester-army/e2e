/** The built-in providers by id, and the login options each one takes. */

import { createCodexProvider, type CodexLoginOptions } from './providers/openai.ts';
import { createCopilotProvider, type CopilotLoginOptions } from './providers/github-copilot.ts';
import { createXaiProvider } from './providers/xai.ts';
import type { OAuthProvider } from './types.ts';

export interface LoginOptionsById {
  readonly openai: CodexLoginOptions;
  readonly 'github-copilot': CopilotLoginOptions;
  readonly spacexai: Record<string, never>;
}

export type ProviderId = keyof LoginOptionsById;

export const PROVIDER_IDS = ['openai', 'github-copilot', 'spacexai'] as const satisfies readonly ProviderId[];

// Method shorthand is bivariant, so each specialised provider fits the base interface without a cast.
const PROVIDERS: Record<ProviderId, OAuthProvider> = {
  openai: createCodexProvider(),
  'github-copilot': createCopilotProvider(),
  spacexai: createXaiProvider(),
};

export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

export function getProvider(id: ProviderId): OAuthProvider {
  return PROVIDERS[id];
}

/** How a missing login is described to the user: the CLI command that fixes it. */
export function loginHint(id: ProviderId): string {
  return `run \`npx e2e login ${id}\``;
}
