---
'@e2edev/web': patch
---

A nested `frameLocator` chain resolves: `web.frameLocator('#outer').frameLocator('#inner').getByText('Saved')` looked the inner selector up in the page instead of the outer frame's document, reported `FRAME_NOT_FOUND` for `#inner` until the deadline, and the test failed `LOCATOR_NOT_FOUND` while Playwright's own `frameLocator` chain found the element. Each frame selector is now counted inside the frame before it, so a chain of any depth resolves, and a missing inner frame still fails `FRAME_NOT_FOUND` naming that selector even when the page happens to hold a matching element.
