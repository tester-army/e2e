---
'e2e': patch
---

Redaction catches a secret the page shows transformed. Each character of a registered value now matches in either case, full and locale-specific mappings included, so a value under CSS `text-transform: uppercase`, `lowercase`, or `capitalize` no longer survives in failure messages, report JSON, Markdown, or terminal output. A whitespace run inside a value also matches any shorter whitespace run, down to the single space a text reader collapses it to, and a value with edge whitespace also matches trimmed while that leaves at least 6 characters, so a multi-line secret echoed in a `<pre>` no longer reaches the model-bound observation, the report, or a saved trace as one line. Text that differs from a secret only in case is now redacted too. Assertions are unchanged.
