---
'e2e': patch
'@e2e-dev/web': patch
---

Agent and MCP observations show a link's whole target. The web engine cut `href` at 80 characters with no marker, so a link to `/projects/<uuid>` read as one to a truncated id. A target on the page's origin now renders as its path, complete and shorter than the URL; a dropped query or fragment shows as `?…` or `#…`; a target past 256 characters ends with `…`. `mailto:` and `tel:` links keep their scheme.
