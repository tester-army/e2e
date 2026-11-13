---
"e2e": patch
---

Keep a carriage return in a JUnit attribute value. `attribute()` encoded `\r` as `&#13;` after `sanitizeText()` had already replaced it with U+FFFD, so the failure message of a CRLF error reached a report viewer with a replacement character where its line break was.
