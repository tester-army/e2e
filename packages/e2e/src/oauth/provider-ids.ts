import type { ProviderId } from './providers.ts';

/** The built-in provider ids. Apart from the providers so the CLI lists them without constructing each one. */
export const PROVIDER_IDS = ['openai', 'github-copilot', 'opencode-console', 'spacexai'] as const satisfies readonly ProviderId[];
