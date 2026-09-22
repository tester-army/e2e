---
'e2e': patch
'@e2edev/web': patch
---

`siteOf` reads a deployment on a shared host as a site of its own: `myapp.vercel.app`, not `vercel.app`, and the same under `netlify.app`, `pages.dev`, `github.io`, `herokuapp.com`, `fly.dev`, `workers.dev`, and the other public hosting suffixes listed in its source. Configured `headers` on such an app rode every request to any other deployment of the host the page touched, and an iframe from another project there was read as the app's own; both now stop at the deployment.
