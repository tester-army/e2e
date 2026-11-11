#!/usr/bin/env bash
# Runs an example's suite for .github/workflows/examples.yml, from the
# example's test directory, with the arguments given passed to `e2e run`.
#
# `--retries` only gives a test failure or a timeout a second attempt; an
# infrastructure failure (exit 3: an engine error, a lost device daemon) stops
# the test, or the whole run, on its first one. On exit 3 the suite gets one
# second pass: the tests the first pass did not pass (`--last-failed`), or the
# whole suite again when the first pass wrote no report. The workflow uploads
# .e2e/first-pass/ with the job's outcome: `second-pass` names the kind of
# second pass for the Slack summary (scripts/examples-nightly/post.ts), and
# `report.json` is the first pass's report, which the second one overwrites.
set -uo pipefail

npx e2e run "$@"
code=$?
if [ "$code" -ne 3 ]; then exit "$code"; fi

mkdir -p .e2e/first-pass
if [ -f .e2e/report.json ]; then
  cp .e2e/report.json .e2e/first-pass/report.json
  echo last-failed > .e2e/first-pass/second-pass
  echo "::warning::infrastructure failure (exit 3); running the tests that did not pass once more"
  npx e2e run "$@" --last-failed
  code=$?
  # A first pass whose tests all passed (a teardown that failed) leaves nothing
  # to select: NO_TESTS exits 2 and leaves the report alone. The infrastructure
  # failure then stands, so a teardown that breaks every night stays red.
  if [ "$code" -eq 2 ] && cmp -s .e2e/report.json .e2e/first-pass/report.json; then
    rm -rf .e2e/first-pass
    exit 3
  fi
  exit "$code"
else
  echo full > .e2e/first-pass/second-pass
  echo "::warning::infrastructure failure (exit 3) before a report was written; running the suite once more"
  npx e2e run "$@"
fi
