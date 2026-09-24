#!/bin/sh
# Runs the mobile benchmark the way CI does, from the package directory: the
# deterministic suite for one target, then the agentic one. The agentic suite
# replays the recordings committed under .e2e/cache and calls the model for a
# step with none, so it needs AI_GATEWAY_API_KEY and runs only when SAME_REPO
# is "true" (the workflow sets it; a fork's pull request has no secrets). The
# credential check comes after the deterministic run, so a missing key never
# turns a green locator suite red.
#
#   scripts/ci-run.sh ios-simulator               # both suites
#   scripts/ci-run.sh ios-simulator deterministic  # one of them
#   scripts/ci-run.sh android-emulator agentic
set -eu

target="${1:?usage: scripts/ci-run.sh <target> [deterministic|agentic|both]}"
suite="${2:-both}"
case "$suite" in deterministic|agentic|both) ;; *) echo "unknown suite: $suite" >&2; exit 2 ;; esac
e2e="node node_modules/e2e/dist/cli/bin.js"

# The report and artifacts upload after the run, and the upload fails whenever
# the repository's artifact quota is full; the failure evidence has to be in
# the log to be worth anything then.
show_failures() {
  find "$1" -path '*/failure/*' -name 'screen.txt' 2>/dev/null | sort | head -n 12 | while read -r screen; do
    echo "::group::$screen"
    head -c 8000 "$screen"
    echo
    echo "::endgroup::"
  done
}

# The suites drive agent-device's runtime on a shared CI machine, and that
# runtime has episodes of its own (#502): a daemon replaced as unreachable in
# the middle of a run, a runner that overruns its watchdog, a fill the Android
# helper cannot verify on a slow emulator. A test that fails is run once more
# in a second pass, alone, once the episode has passed; the first pass's
# failure screens stay in the log for the record. `--last-failed` reads the
# report the first pass wrote, so the second pass takes the same arguments.
run_suite() {
  artifacts="$1"
  shift
  if $e2e run "$@"; then
    return 0
  fi
  show_failures "$artifacts"
  echo "::warning::tests failed; rerunning the failed ones once (agent-device runtime episodes, #502)"
  if $e2e run "$@" --last-failed; then
    return 0
  fi
  show_failures "$artifacts"
  return 1
}

if [ "$suite" != "agentic" ] && ! run_suite .e2e/artifacts --target "$target"; then
  exit 3
fi
if [ "$suite" = "deterministic" ]; then
  exit 0
fi

if [ "${SAME_REPO:-}" != "true" ]; then
  echo "agentic suite skipped: a fork's pull request has no model credential"
  exit 0
fi
if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  echo "::error::AI_GATEWAY_API_KEY is not set for this repository; the agentic suite needs it for a step with no recording."
  exit 1
fi
if ! run_suite .e2e/agent/artifacts --config e2e.agent.config.ts --target "$target" --artifacts .e2e/agent/artifacts; then
  exit 3
fi
