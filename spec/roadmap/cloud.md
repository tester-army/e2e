# Roadmap - Hosted Runner

This document is nonnormative. No cloud config, CLI flag, token, or subpath is
reserved by specification 0.1.

The product goal is unchanged test source with a hosted implementation of the
same versioned profiles. That promise is not valid until these protocols exist.

## Required profiles

### Execution bundle

A bundle must identify source files, package manager and frozen lockfile,
runtime/OS/architecture, config digest, SDK/driver/model-adapter versions,
browser/device artifacts, environment variable names, and allowed filesystem
roots. Arbitrary local closures and driver instances must resolve from the
bundle, not be serialized as values.

The service must verify integrity and build in an ephemeral sandbox with no
ambient customer credentials.

### Identity and tokens

CI authentication should use OIDC and short-lived scoped credentials. Runner
tokens must not be visible to test/config/driver processes. Tenant, project,
repository, branch, and run identity are distinct authorization dimensions.

### Isolation

Each run needs an ephemeral tenant-isolated filesystem, process namespace,
network policy, browser/device lease, artifact namespace, cache namespace, and
session namespace. Untrusted branches cannot read or write trusted branch data.

### Secrets and sessions

Secrets are brokered to authorized sinks without entering the test process when
possible. Persisted sessions require authenticated encryption, KMS-backed key
separation, TTL, revocation, audit, and app/target/driver binding. Cross-run
reuse is opt-in and never implied by local `session-1`.

### Reports and artifacts

Hosted execution negotiates every required SDK/runner/core/web/driver/agent-tool/
report/cache/session/conformance profile before upload. `report-1` remains downloadable. Artifacts are
private, encrypted, integrity-checked, retention-bounded, access-audited, and
deletable. Redaction requirements remain fail-closed.

### Cancellation and billing

Cancellation propagates through models, drivers, devices, app processes,
resources, uploads, and queues. Partial reports survive. Quotas and estimated
cost are visible before and during execution; exceeded quota cannot leave
billable work running.

## Candidate UX

Only after those profiles freeze may a config or CLI choose a hosted runner.
The intended UX is one execution-location switch and zero test-file changes,
but exact names remain undecided.

Managed browsers/devices, models, resource extensions, shared read-only cache,
scheduled runs, and hosted reports can then be capabilities of the hosted
profile rather than a parallel test format.
