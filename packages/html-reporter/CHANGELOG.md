# @e2e-dev/html-reporter

## 0.0.1

### Patch Changes

- [#1730](https://github.com/e2e-inc/e2e/pull/1730) [`7e309c1`](https://github.com/e2e-inc/e2e/commit/7e309c151e4d82f7c1e14c139ba77ed0c7993ee9) Thanks [@karolkulesza](https://github.com/karolkulesza)! - The setup guide's link to the `command` reference no longer returns 404. The e2b and HTML reporter READMEs link to e2e.com instead of e2e.tester.army.

- [#1672](https://github.com/e2e-inc/e2e/pull/1672) [`3735887`](https://github.com/e2e-inc/e2e/commit/373588756937562aa89c7dd7f7995ac6b16db972) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Move GitHub repository metadata and CLI links to e2e-inc/e2e after the organization rename. Register the MCP server as io.github.e2e-inc/e2e.

- [#1642](https://github.com/e2e-inc/e2e/pull/1642) [`a133807`](https://github.com/e2e-inc/e2e/commit/a13380728fc0822f1da477fdec0da10632c84cc0) Thanks [@KrzysztofMoch](https://github.com/KrzysztofMoch)! - New package: `htmlReporter()` writes the run as one HTML page, `.e2e/report.html`, that opens from disk with no server. It lists the tests by file with status tabs and search, and shows each test's attempts, error, steps, screenshots, and video, with each step linked to its moment in the video. Agent steps show their explanation, the actions they took, the model, tokens and cost, and whether the step replayed from the cache. A failed assertion that reports expected and received values shows them with the difference marked. When the test file is in the project, the failure shows the code around the failing call, and each step opens to its code. **copy prompt** on a failed test copies its failure, steps, and file paths for a coding agent. The page has a light and a dark theme, following the system's by default. `media: 'embed'` puts screenshots and videos in the page so the one file is the whole report, and `media: 'none'` leaves them out.
