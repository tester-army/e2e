---
'e2e': patch
---

A trace of an attempt whose engine holds a secret (`web({ basicAuth: { password: secrets.get(name) } })`) no longer keeps the password base64-encoded in the `Authorization: Basic` header of every request after the challenge. Trace redaction now decodes each base64 and base64url run and replaces a run that holds a secret, or 8 or more characters of one, with its `<secret:name>` marker, so cookies and token segments that encode a secret are covered too. Before, the report labelled such a trace `redaction: "complete"`.
