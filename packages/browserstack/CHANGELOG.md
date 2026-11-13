# @e2e-dev/browserstack

## 0.1.1

### Patch Changes

- [#1672](https://github.com/e2e-inc/e2e/pull/1672) [`3735887`](https://github.com/e2e-inc/e2e/commit/373588756937562aa89c7dd7f7995ac6b16db972) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Move GitHub repository metadata and CLI links to e2e-inc/e2e after the organization rename. Register the MCP server as io.github.e2e-inc/e2e.

- [#1715](https://github.com/e2e-inc/e2e/pull/1715) [`be460ec`](https://github.com/e2e-inc/e2e/commit/be460ecd91f4790884a36127310aab0d33853903) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Redact project tool results and errors before the model or AI trace recorder reads them, and redact and bound skip reasons before reporting. Avoid repeated scanning of malformed stack frames and trailing slashes in provider API endpoints. Keep ACP forwarding errors out of HTTP responses while preserving the cause in the runner's redacted failure output.

## 0.1.0

### Minor Changes

- [#1307](https://github.com/tester-army/e2e/pull/1307) [`64432f1`](https://github.com/tester-army/e2e/commit/64432f10891d9772494137b0ba328d8ef440deae) Thanks [@malopezr7](https://github.com/malopezr7)! - **Release:** New package: `@e2e-dev/browserstack`. `browserstack()` leases BrowserStack App Automate real Android and iOS devices for the mobile engine, one isolated agent-device daemon per worker slot. An `https` `app` is uploaded once per run, an attempt's video links BrowserStack's recording of the session, and a release fails the run when agent-device can't confirm it ended the session.
