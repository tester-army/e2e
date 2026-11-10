---
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

Open an MCP session in a directory with no config: `open_session {engine: "@e2e-dev/web", app: {url}}` names the engine to drive and `app` the app under test. `engine` is a package name, or the factory call a config would write as `{package, export, options}`, where an option can be another such call: `{package: "@e2e-dev/mobile", options: {platform: "ios", device: {package: "@e2e-dev/limrun", export: "limrun"}}}`. Each package is found in the project, beside e2e, or in `~/.e2e/engines`; when it is in none, `ENGINE_NOT_INSTALLED` names the install command. `@e2e-dev/web` and `@e2e-dev/mobile` export their factory as the default export for this.
