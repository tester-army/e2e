# @e2edev/oauth

Sign in to a personal AI subscription once, then use it as a [Vercel AI SDK](https://ai-sdk.dev) model.

| Plan | Login | Model |
| --- | --- | --- |
| ChatGPT Plus/Pro (the Codex sign-in) | `npx e2e-oauth login openai` | `chatgpt('gpt-5.5')` from `@e2edev/oauth/chatgpt` |
| GitHub Copilot | `npx e2e-oauth login github-copilot` | `copilot('claude-sonnet-5')` from `@e2edev/oauth/copilot` |
| SuperGrok / X Premium+ | `npx e2e-oauth login spacexai` | `grok('grok-4')` from `@e2edev/oauth/grok` |

Each subpath needs its provider package: `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, or `@ai-sdk/xai`.

```ts
import { generateText } from 'ai';
import { chatgpt } from '@e2edev/oauth/chatgpt';

const { text } = await generateText({ model: chatgpt('gpt-5.5'), prompt: 'Hello' });
```

How it works: the login runs the vendor's OAuth flow (PKCE with a local callback, or an RFC 8628 device code) and stores the tokens in `~/.config/e2e/oauth.json` with mode 0600. The model is the vendor's own AI SDK provider constructed with a `fetch` that reads the stored login per request, refreshes it ahead of expiry (once, however many calls race), replaces the SDK's key header with the bearer token, and applies what the vendor needs beyond that: the Codex backend URL and body shape for ChatGPT, the initiator and vision headers for Copilot.

For your own product, `createOAuthFetch(provider, { store, userAgent })` is the `fetch` any provider factory accepts, `login(providerId, { callbacks })` runs a flow with your prompts, and `OAuthProvider` is the interface a new vendor implements. Set `userAgent` and `originator` to your product's name.

Claude Pro/Max is not included: Anthropic permits subscription sign-in only for its own applications.

Docs: https://e2e.tester.army/subscriptions
