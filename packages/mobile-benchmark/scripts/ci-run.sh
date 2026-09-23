#!/bin/sh
# Runs the mobile benchmark the way CI does, from the package directory: the
# deterministic suite for one target, then the agentic one. The agentic suite
# replays the recordings committed under .e2e/cache and calls the model for a
# step with none, so it needs AI_GATEWAY_API_KEY and runs only when SAME_REPO
# is "true" (the workflow sets it; a fork's pull request has no secrets). The
# credential check comes after the deterministic run, so a missing key never
# turns a green locator suite red.
#
#   scripts/ci-run.sh ios-simulator
#   scripts/ci-run.sh android-emulator
set -eu

target="${1:?usage: scripts/ci-run.sh <target>}"
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

if ! $e2e run --target "$target"; then
  show_failures .e2e/artifacts
  exit 3
fi

if [ "${SAME_REPO:-}" != "true" ]; then
  echo "agentic suite skipped: a fork's pull request has no model credential"
  exit 0
fi
if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  echo "::error::AI_GATEWAY_API_KEY is not set for this repository; the agentic suite needs it for a step with no recording."
  exit 1
fi
if ! $e2e run --config e2e.agent.config.ts --target "$target" --artifacts .e2e/agent/artifacts; then
  show_failures .e2e/agent/artifacts
  exit 3
fi
