# 06 - CLI and Run Outcomes

The v0 binary is `e2e`. CLI behavior is part of `runner-0.1`.

## `e2e init`

`e2e init` is non-destructive. It creates only missing files, reports every
existing conflict, and makes no partial changes after a conflict is found. It:

- creates a minimal `e2e.config.ts` when needed;
- creates `tests/example.e2e.ts` containing a deterministic app-open smoke
  test, not an app-specific signup assumption;
- adds `.e2e/artifacts/`, `.e2e/sessions/`, and generated reports to
  `.gitignore`, while leaving `.e2e/cache/` committable;
- prints the exact next command.

Browser provisioning uses the locked driver/backend version installed with the
project. The runner MUST NOT execute a mutable package version or download an
unverified browser binary.

## `e2e run`

```bash
npx --no-install e2e run
npx --no-install e2e run tests/signup.e2e.ts --tag smoke
```

| Flag | Behavior |
|---|---|
| `--config <path>` | explicit config path |
| `--target <ids>` | comma-separated target IDs; unknown IDs are errors |
| `--tag <tag>` | repeatable tag filter |
| `--tag-mode <any\|all>` | tag composition, default `any` |
| `--headed` | request visible UI when the driver supports it |
| `--retries <n>` | replace resolved retry count |
| `--workers <n>` | replace worker count |
| `--reporter <ids>` | comma-separated `list`, `json`; replaces config |
| `--artifacts <dir>` | artifact root, default `.e2e/artifacts` |
| `--no-agent-cache` | cache mode `off` |
| `--pass-with-no-tests` | allow zero runnable ordinary test-target pairs |

Positional file arguments resolve from project root and intersect config globs,
tags, platform filters, and capability filters. A positional path outside the
project root is an error. Selection and setup dependency rules are in
11-lifecycle.md.

## Output

The list reporter writes human-readable progress to the terminal. It strips
control characters from app, model, and driver text and caps each untrusted
field at 8 KiB before linking to the complete sanitized artifact.

Every run atomically writes `.e2e/report.json` under the artifact parent. The
`json` renderer additionally emits that document to standard output and cannot
be combined with `list`. The HTML reporter writes `.e2e/report.html`, uses no
remote resources, escapes all values contextually, and applies a restrictive
Content Security Policy. `--artifacts` relocates the complete report/artifact
tree.

Every reporter consumes the same `report-1` document. A reporter cannot change
run status. Exact fields are defined in 13-reporting.md.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | all selected tests passed, were flaky, or were explicitly skipped |
| 1 | final test/setup product failure or test timeout |
| 2 | CLI, config, collection, dependency, credential, model-config, or policy error |
| 3 | driver, browser, app process, model provider, artifact, or cleanup infrastructure failure |
| 4 | internal runner invariant or unhandled runner error |
| 130 | interrupted by user or CI signal |

For mixed outcomes, precedence is `130 > 4 > 3 > 2 > 1 > 0`. The report keeps
every individual result; precedence affects only the process exit code.

Representative mappings:

| Error | Result/exit class |
|---|---|
| `AUTH_CREDENTIAL_UNAVAILABLE`, `MODEL_UNAVAILABLE`, `POLICY_DENIED` | configuration, 2 |
| duplicate test/session, invalid config, zero tests, `.only` in CI | configuration, 2 |
| driver launch, `APP_UNREACHABLE`, `MODEL_PROVIDER_FAILED` | infrastructure, 3 |
| `APP_NOT_OPEN`, `AUTHENTICATION_FAILED`, locator/action failures | test failure, 1 |
| `ASSERTION_FAILED`, `STEP_NO_CONCLUSION`, test `STEP_TIMEOUT` | test failure, 1 |
| malformed provider output after repair | test failure, 1 |
| report write, artifact finalization, process cleanup | infrastructure, 3 |
| runner-created cancellation without process signal | infrastructure, 3 |

A setup assertion is a test failure and skips its dependents. Missing setup
infrastructure retains its configuration/infrastructure class. The model does
not choose any classification.

Config, tests, model adapters, and in-process drivers are trusted executable
code with the runner's OS authority. This trust model is documented in
[14-security.md](./14-security.md) and recorded in report provenance
(`environment.trustNoticeShown` states whether a runner printed a startup
notice); printing a startup notice is optional.

v0 does not sandbox untrusted test/config/driver code. Such code requires an
external ephemeral OS/container boundary with no secrets or privileged tokens;
the runner cannot create that trust boundary through a flag.

## Signals and partial reports

On the first interrupt signal, the runner aborts active model/driver work,
executes bounded teardown, writes an atomic partial report with
`status: interrupted`, and exits 130. A second signal MAY force immediate exit.
An operation that ignores cancellation causes its worker/process group to be
terminated and is recorded as a cleanup error.

## Post-v0 commands

Watch mode, inspector UI, credential-store commands, sharding, migration, and
cloud commands are not part of `runner-0.1`.
