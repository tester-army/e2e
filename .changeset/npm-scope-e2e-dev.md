---
'e2e': minor
'@e2e-dev/web': minor
'@e2e-dev/mobile': minor
'@e2e-dev/github': minor
---

The engines and the reporter publish under the `@e2e-dev` scope: `@e2edev/web` is `@e2e-dev/web`, `@e2edev/mobile` is `@e2e-dev/mobile`, and `@e2edev/github` is `@e2e-dev/github`. The `@e2edev` packages get no new releases. To move, swap the dependencies (`npm uninstall @e2edev/web && npm install --save-dev @e2e-dev/web`) and rewrite the imports: `from '@e2edev/web'` becomes `from '@e2e-dev/web'`, and the same for `@e2edev/mobile`, `@e2edev/mobile/tools`, and `@e2edev/github`. `e2e init` installs and imports the new names.
