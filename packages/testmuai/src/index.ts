/**
 * `@e2e-dev/testmuai` public surface: `testmuai()`, a browser provider
 * that runs `@e2e-dev/web` targets in TestMu AI's hosted Chrome and Edge.
 * TestMu AI creates a session when its CDP websocket is opened, so the
 * provider needs no SDK and makes no API calls.
 */

export { testmuai } from './provider.ts';
export type { TestMuAIBrowser, TestMuAIOptions, TestMuAIRoute } from './provider.ts';
