---
"@e2edev/e2e": patch
---

Replace inline base64 media in AI trace prompts and response messages with
decoded byte counts, including structured tool content. This reduces trace
size when image or file results recur in conversation history. URLs, text,
and arbitrary tool result JSON are preserved; encoded strings outside SDK
media message parts are not omitted.
