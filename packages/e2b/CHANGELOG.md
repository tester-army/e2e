# @e2e-dev/e2b

## 0.0.1

### Patch Changes

- [#1735](https://github.com/e2e-inc/e2e/pull/1735) [`16ff228`](https://github.com/e2e-inc/e2e/commit/16ff228576b0c5959d96450a626faafd580bdc75) Thanks [@gronxb](https://github.com/gronxb)! - Update agent-device to 0.21.37. Without `device`, the iOS pool no longer picks a paired iPhone that is not connected: agent-device now lists a phone whose CoreDevice tunnel is unavailable as not booted. A `device` that names such a phone fails in `prepare` with "iOS device is not ready for automation", before any test runs, instead of at app launch. A test's own swipe and scroll now skip agent-device's post-gesture wait, which 0.21.36 ignored.

- [#1730](https://github.com/e2e-inc/e2e/pull/1730) [`7e309c1`](https://github.com/e2e-inc/e2e/commit/7e309c151e4d82f7c1e14c139ba77ed0c7993ee9) Thanks [@karolkulesza](https://github.com/karolkulesza)! - The setup guide's link to the `command` reference no longer returns 404. The e2b and HTML reporter READMEs link to e2e.com instead of e2e.tester.army.

- [#1598](https://github.com/e2e-inc/e2e/pull/1598) [`ae5d121`](https://github.com/e2e-inc/e2e/commit/ae5d1215144061939afef46578856dcdd696360e) Thanks [@tomasvarga](https://github.com/tomasvarga)! - New package: `e2b()`, a device provider that runs Android 16 in one E2B sandbox per worker slot and installs the target's `.apk`, and `e2bBrowsers()` from `@e2e-dev/e2b/web`, a browser provider that runs Chromium in E2B sandboxes per worker slot or per attempt.

- [#1672](https://github.com/e2e-inc/e2e/pull/1672) [`3735887`](https://github.com/e2e-inc/e2e/commit/373588756937562aa89c7dd7f7995ac6b16db972) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Move GitHub repository metadata and CLI links to e2e-inc/e2e after the organization rename. Register the MCP server as io.github.e2e-inc/e2e.
