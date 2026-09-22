---
'e2e': minor
---

The secret redactor matches each value character by character, in every spelling a serializer gives a character: percent-encoding in lower-case hex, decimal and hex character references (`&#39;`, `&#039;`, `&#x27;`), `\uXXXX` JSON escapes in either case, and a JSON-escaped slash all redact now, on top of the raw, JSON, HTML, and URL forms already covered. Base64, another Unicode normalization form, and a value spread over several nodes stay out of scope and are listed as such on the security page.

A static secret or credential password shorter than 6 characters (code points) is `INVALID_CONFIG`, and a provider returning one fails the fill. Redaction rewrites every occurrence of a value, so `E2E_SECRET_PIN=7` turned every `7` in a report into `<secret:pin>`.

A test's console output is redacted across writes: a value split over two `process.stdout.write` calls, or over the chunks of a piped child's output, no longer reaches the reporter in halves, and a multibyte character split between chunks decodes whole. A write that ends mid-line holds back its tail until the next write, the next test's start, or the test's result, attributed to the test that wrote it.
