# e2e Specification

This directory defines e2e specification **0.1**, a local-first agentic testing
framework standard.

**Status: frozen implementation contract.** The reference implementation
(`packages/e2e`, `packages/playwright`) tracks it and is exercised in CI, but no
profile is claimed conformant: the required-ID set is
[`conformance/v0-requirements.json`](./conformance/v0-requirements.json) (see
[15-conformance-matrix.md](./15-conformance-matrix.md)) and no `conformance-1`
report is produced until the conformance harness lands.

v0 executes web targets. The API is designed for future mobile profiles, but
iOS and Android execution are not claimed until their conformance suites exist.

## Documents

| Document | Contract |
|---|---|
| [00-conformance.md](./00-conformance.md) | normativity, profiles, versions, portability |
| [01-principles.md](./01-principles.md) | design laws and non-goals |
| [02-test-api.md](./02-test-api.md) | registration, fixtures, agent calls |
| [03-assertions.md](./03-assertions.md) | deterministic and agent assertions |
| [04-resources.md](./04-resources.md) | credentials and resource ownership |
| [05-config.md](./05-config.md) | config loading, defaults, targets, model |
| [06-cli.md](./06-cli.md) | commands, selection, reports, exit codes |
| [07-scope.md](./07-scope.md) | frozen v0 release boundary |
| [08-platforms.md](./08-platforms.md) | web profile, queries, app/web behavior |
| [09-drivers.md](./09-drivers.md) | versioned driver SPI and conformance |
| [10-determinism.md](./10-determinism.md) | control gradient and ledger |
| [11-lifecycle.md](./11-lifecycle.md) | collection, hooks, attempts, sessions |
| [12-migration.md](./12-migration.md) | informative migration coverage |
| [13-reporting.md](./13-reporting.md) | report/session wire semantics |
| [14-security.md](./14-security.md) | trust, origins, secrets, CI, redaction |
| [15-conformance-matrix.md](./15-conformance-matrix.md) | complete required-ID manifest |
| [16-executors.md](./16-executors.md) | the step-executor socket behind `agent.act` |
| [examples/](./examples/README.md) | canonical source examples |
| [roadmap/](./roadmap/README.md) | nonnormative deferred designs |

Canonical declarations:

- [`api/e2e.d.ts`](./api/e2e.d.ts) for `sdk-0.1`;
- [`api/driver.d.ts`](./api/driver.d.ts) for `driver-1`.

Canonical wire schemas:

- [`schema/report-v1.schema.json`](./schema/report-v1.schema.json);
- [`schema/session-v1.schema.json`](./schema/session-v1.schema.json);
- [`schema/agent-judgment-v1.schema.json`](./schema/agent-judgment-v1.schema.json);
- [`schema/agent-tool-v1.schema.json`](./schema/agent-tool-v1.schema.json);
- [`schema/conformance-v1.schema.json`](./schema/conformance-v1.schema.json).

Required conformance IDs:

- [`conformance/v0-requirements.json`](./conformance/v0-requirements.json).

## Package

- npm package and CLI: `e2e`;
- root SDK import: `e2e`;
- engine authoring import: `@e2edev/e2e/engine`;
- reference web engine: `@e2edev/playwright` (`playwright()`);
- default tests: `tests/**/*.e2e.ts`;
- config: `e2e.config.ts` or `e2e.config.mts`.

## Minimal test

```ts
import { test } from '@e2edev/e2e';

test('user can sign up', async ({ app, agent }) => {
  await app.open();
  await agent.act('sign up as a new user');
  await agent.assert('the dashboard is visible');
});
```

Agent tests require an explicit model. Deterministic tests do not.

## Normativity

Normative precedence and BCP 14 language are defined only in
00-conformance.md. Root documents, examples, migration guidance, and roadmap
designs are informative and must be checked against the canonical contracts.
Canonical declarations and examples are type-checked in CI, and the reference
implementation validates the `report-1` documents it writes
against the schemas here. Full semantic validation lands with the
implementation conformance suites before release.
