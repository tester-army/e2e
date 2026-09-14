---
'e2e': patch
---

Include report attempt and step identity on every live step phase so reporters can distinguish retries and nested steps. End phases also carry the redacted step error and explanation, including blocked and cancelled outcomes.
