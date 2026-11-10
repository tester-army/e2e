---
'@e2e-dev/limrun': patch
---

A Limrun device lease no longer names an agent-device `session` in its client configuration, which `@e2e-dev/mobile` rejected with `ENGINE_FAILURE` ("returned a lease without an id and a daemon baseUrl or JSON client configuration") before any test or session could start. The provider still allocates and renews the lease under its own session.
