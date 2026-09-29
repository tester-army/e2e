---
'e2e': patch
'@e2e-dev/web': patch
---

Agent and MCP observations show a link's whole target. The web engine cut `href` at 80 characters with no marker, so a link to `/projects/<uuid>` read as one to a truncated id. A target on the app URL's origin now renders as its path, complete and shorter than the URL, and any other keeps its origin; a dropped query or fragment shows as `?…` or `#…`, a `data:` or `javascript:` payload as `data:…` or `javascript:…`, and a target past 256 characters ends with `…`, in the line the model reads and the tree a custom executor gets. `mailto:`, `tel:`, and `blob:` links keep their scheme.
