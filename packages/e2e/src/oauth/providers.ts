/** The built-in providers by id, and the login options each one takes. */

import { createCodexProvider, type CodexLoginOptions } from './providers/openai.ts';
import { createCopilotProvider, type CopilotLoginOptions } from './providers/github-copilot.ts';
import { createOpencodeConsoleProvider } from './providers/opencode-console.ts';
import { createXaiProvider } from './providers/xai.ts';
import type { OAuthProvider } from './types.ts';

export interface LoginOptionsById {
  readonly openai: CodexLoginOptions;
  readonly 'github-copilot': CopilotLoginOptions;
  readonly 'opencode-console': Record<string, never>;
  readonly spacexai: Record<string, never>;
}

export type ProviderId = keyof LoginOptionsById;

export const PROVIDER_IDS = ['openai', 'github-copilot', 'opencode-console', 'spacexai'] as const satisfies readonly ProviderId[];

// Method shorthand is bivariant, so each specialised provider fits the base interface without a cast.
const PROVIDERS: Record<ProviderId, OAuthProvider> = {
  openai: createCodexProvider(),
  'github-copilot': createCopilotProvider(),
  'opencode-console': createOpencodeConsoleProvider(),
  spacexai: createXaiProvider(),
};

export function isProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

export function getProvider(id: ProviderId): OAuthProvider {
  return PROVIDERS[id];
}

/** The environment credential a provider also accepts, where it has one. */
const ENV_CREDENTIALS: Partial<Record<ProviderId, string>> = { 'opencode-console': 'OPENCODE_API_KEY' };

/**
 * How a missing login is described to the user: the CLI command that fixes
 * it, and the environment credential that does too, so the message never
 * reads as "no credentials" while a working one is set.
 *
 * `environment: false` names the command alone, for the caller whose stored
 * login outranks the environment credential: telling that caller to set a
 * variable the call would ignore sends them down a dead end.
 */
export function loginHint(id: ProviderId, options: { readonly environment?: boolean } = {}): string {
  const command = `run \`npx e2e login ${id}\``;
  const environment = options.environment === false ? undefined : ENV_CREDENTIALS[id];
  return environment === undefined ? command : `${command} or set ${environment}`;
}
