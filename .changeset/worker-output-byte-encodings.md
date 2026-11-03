---
"e2e": patch
---

A string a test or the config writes to `process.stdout` or `process.stderr` with an encoding, such as `hex`, `base64`, or `latin1`, now prints decoded from a worker, as Node prints it. The runner process decoded only `hex`, `base64`, and `base64url`, and now decodes every encoding Node accepts too. Bytes that end inside a UTF-8 character no longer print after the string written next.
