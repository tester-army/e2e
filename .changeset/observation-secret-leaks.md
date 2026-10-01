---
"e2e": patch
---

A registered secret no longer leaks through the observed screen: a test id, an iframe name in a frame path, a selector, or an attribute holding one is masked in the model's text, an executor's tree, and cache entries, and a secret with a line break, tab, CRLF, no-break space, or repeated spaces that an engine collapsed and then cut at the name or text limit no longer leaves its leading part in observations or end anchors.
