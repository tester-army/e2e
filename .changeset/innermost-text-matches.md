---
'@e2edev/agent-device': patch
---

`getByText` on a device target now resolves to the innermost matching node, as in a browser. iOS reports a React Native `Text` as a host view plus a `StaticText` child with the same label, and container views inherit their children's labels, so every text query on such screens failed with `LOCATOR_AMBIGUOUS`. Ancestors whose match is echoed by a matching descendant are dropped; unrelated duplicates still fail.
