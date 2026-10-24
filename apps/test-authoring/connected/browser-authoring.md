## Browser test constraints

Return one nonempty, self-contained UTF-8 TypeScript file at `tests/requirement.e2e.ts`. Import `test` from `@e2e-dev/web` and `expect` from `e2e`, with these exact unaliased named imports. Do not import anything else, including app modules. Use deterministic public browser actions and visible assertions. Ordinary helper functions, loops and destructuring are allowed.

Use dot property access. Computed property access is excluded everywhere, including array indexing such as `cases[0]`. Use iteration or destructuring instead. Dynamic imports, `import.meta`, `new.target`, `with`, named exports, reexports, filesystem access, explicit network calls, browser scripts and runtime agent steps are excluded.

Do not use these identifiers anywhere in the returned file: `process`, `globalThis`, `global`, `require`, `module`, `exports`, `eval`, `Function`, `fetch`, `WebSocket`, `XMLHttpRequest`, `Bun`, `Deno`, `agent`, `window`, `document` or `navigator`. This restriction also applies to helper and parameter names.

Do not access properties named `constructor`, `__proto__`, `prototype`, `skip`, `only`, `todo`, `fixme`, `extend`, `use`, `setup`, `configure`, `evaluate`, `route`, `request` or `initScripts`. Keep supplied app, lower-test, skill, dependency and configuration files unchanged. Local output under `.data`, `.e2e`, `.home` and `.tmp` is allowed.
