# Roadmap - Pull Request Testing

This document is nonnormative. PR metadata, selection, dynamic exploration,
GitHub reporting, and an `e2e pr` command are not part of v0.

## Goals

- run ordinary static tests against an explicitly allowed preview target;
- deterministically select tests from changed files without hiding coverage;
- optionally perform advisory model exploration;
- publish results without giving untrusted code privileged tokens.

## Trust split

PR code, dependencies, config, tests, metadata, diff, preview app, caches, and
generated reports are untrusted. A safe design requires two jobs:

1. An unprivileged execution job checks out and runs PR code with no repository
   secrets, write token, production credentials, shared cache/session writes,
   or trusted network placement. It emits a sanitized signed report through the
   quarantined repository/run/head-bound channel defined by a future profile.
2. A trusted reporting job does not checkout, import, build, or execute PR code.
   It validates the report artifact and uses a narrowly scoped token to publish
   a check.

`pull_request_target` must never combine a privileged context with untrusted
checkout or dependencies. Fork behavior, token permissions, artifact integrity,
retention, and replay protection must be conformance-tested.

## Metadata resource

If adopted, PR metadata belongs in a versioned extension import rather than a
universal fixture. The wire-safe value may contain provider, repository,
number, base/head commit, changed paths, labels, preview URL, and bounded diff.
PR title/body/diff are quoted untrusted model data and cannot alter policy.

Local fallback must use explicit base/head commits and fail when history is
insufficient; it must not silently choose the current branch or skip tests.

## Preview policy

Preview URLs pass normal target environment/origin policy. Resolution is
deterministic and records which trusted source supplied the URL. Redirects,
frames, production domains, link-local addresses, and credential scopes remain
restricted by 14-security.md.

## Selection

Path-to-test mapping is deterministic, versioned, and reported. Selection
errors fail closed. Framework/config/dependency/unknown changes select the full
suite by default. A smoke fallback is allowed only through explicit project
policy.

The report lists discovered, selected, filtered, skipped, and executed
test-target pairs. Zero selected tests is an error unless explicitly permitted.

## Dynamic exploration

Exploratory PR testing, if added, is a separate advisory result kind with an
explicit blocking policy. It receives bounded metadata, existing test names,
and allowed app observations. It cannot inspect repository files, execute diff
content, expand origins/tools, or publish privileged output directly.

## GitHub output

Publishing consumes a validated versioned report and produces escaped,
size-bounded annotations. It does not trust model-suggested file paths or line
numbers without validating them against the base repository. Workflow examples
use frozen lockfiles, local binaries, immutable action SHAs, and minimal
permissions.
