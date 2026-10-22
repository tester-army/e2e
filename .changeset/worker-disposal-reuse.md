---
"e2e": patch
"@e2e-dev/web": patch
---

Engine disposal receives optional revocable permission to preserve run-owned resources for a replacement worker. Final shutdown, forced termination, and parent disconnect revoke that permission while disposal is pending. Each worker still invokes an engine's disposal hook one time. Missing permission requests final cleanup, including direct and standalone calls.
