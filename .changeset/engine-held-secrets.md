---
'e2e': patch
'@e2e-dev/web': patch
---

A secret an engine option holds (`web({ basicAuth: { password: secrets.get(name) } })`) now has its text downloads rewritten through the redactor too, as its trace already was, and the web engine registers the base64 `user:password` credential of the `Authorization` header for redaction, so a page that echoes its request headers shows `Basic <secret:name>` in the report, `screen.txt`, the failure pages, the trace, what the model reads, and `e2e mcp` observations. The protection is text only: screenshots, the trace's screencast frames, and the model's pixels are kept as with no secret, so a page that renders the basic-auth password on screen is not masked in pixels. Engines pass such derived forms through the new `resolveSecret(secret, { derived })` option.
