---
"e2e": minor
---

OrcaRouter is a first-class model provider, with two ways to authenticate.

`orcarouter('orcarouter/auto')` from `e2e/oauth/orcarouter` reaches
`https://api.orcarouter.ai/v1` with an `sk-orca-…` API key from
`ORCAROUTER_API_KEY` or from `npx e2e login orcarouter`, which prompts for one
and stores it in the same credential file the subscription logins use.
`orcarouterAuth('orcarouter/auto')` from `e2e/oauth/orcarouter-auth` reaches
the same endpoint after `npx e2e login orcarouter-oauth` authorizes in a
browser over OAuth 2.0 with PKCE; no client secret and no pre-registered
redirect URI are involved, and the flow mints an ordinary API key, so both
entries send identical requests.

`e2e init` offers both as gateways, and `e2e models orcarouter` lists the ids
the account serves. The model list is read from the catalog on the same
origin, filtered per capability from the record's own metadata: a chat model
declares an OpenAI-compatible endpoint type, and a model offered for image
input additionally declares the `image` input modality, so a text-only model
is never offered where a screenshot is sent. A catalog outage falls back to a
small list verified against the live endpoint.

The key OrcaRouter issues is durable: there is no refresh grant, so it is
reused until it is revoked, and a `401` from the relay asks the user to sign in
again rather than retrying a dead credential. `ORCA_BASE_URL`,
`ORCA_AUTH_BASE_URL`, and `ORCA_API_BASE_URL` point the two origins at a
self-hosted deployment.
