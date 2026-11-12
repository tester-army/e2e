---
"e2e": patch
"@e2e-dev/acp": patch
"@e2e-dev/browserstack": patch
"@e2e-dev/testmu": patch
---

Redact project tool results and errors before the model or AI trace recorder reads them, and redact and bound skip reasons before reporting. Avoid repeated scanning of malformed stack frames and trailing slashes in provider API endpoints. Keep ACP forwarding errors out of HTTP responses while preserving the cause in the runner's redacted failure output.
