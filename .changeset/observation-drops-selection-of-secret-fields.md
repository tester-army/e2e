---
'e2e': patch
---

A plain field whose value or text holds a registered secret no longer lists its `selection` in an observation. Selecting part of a secret in a text field showed those characters to the model, in the executor tree, and in `failure/screen.txt`, because redaction matches whole values only; the selection is now dropped the way a secure field's is. So is the selection of a field cut at its length limit that is not in the part shown.
