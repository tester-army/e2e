---
'@e2edev/e2e': minor
---

Two hosted-cache seams. A host-supplied `cache.store` is now exempt from the
CI read-only clamp: the clamp exists because committed file caches are
untrusted input, and a remote store a host operates is neither committed nor
untrusted — it states its own trust through `writable`. And the new
`app.identity` config keys cache and session identity by a stable logical app
identity instead of the base URL's origin, so ephemeral per-deploy origins
(PR previews) share their recorded traces; the environment always joins the
derived identity, so an identity never bleeds entries across environments.
