#!/usr/bin/env bash
# Builds App.swift for the simulator, then writes the raw snapshot of each
# screen to the mobile engine's iOS fixtures. Usage: capture.sh <simulator-udid>
set -euo pipefail

UDID="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
OUT="$REPO/packages/mobile/tests/fixtures/snapshots/ios"
CLI="$REPO/packages/mobile/node_modules/.bin/agent-device"
APP="$(mktemp -d)/SwiftUIBar.app"
SESSION=swiftui-bar

mkdir -p "$APP"
cp "$HERE/Info.plist" "$APP/Info.plist"
xcrun -sdk iphonesimulator swiftc -parse-as-library -target arm64-apple-ios17.0-simulator "$HERE/App.swift" -o "$APP/SwiftUIBar"
codesign -s - --force "$APP"
xcrun simctl install "$UDID" "$APP"
"$CLI" open dev.e2e.swiftuibar --platform ios --udid "$UDID" --session "$SESSION" >/dev/null
trap '"$CLI" close --session "$SESSION" >/dev/null 2>&1 || true' EXIT

# Writes a snapshot once two in a row have the same types, labels, and values.
capture() {
  node -e '
    const { execFileSync } = require("node:child_process");
    const [cli, session, out] = process.argv.slice(1);
    const take = () => JSON.parse(execFileSync(cli, ["snapshot", "--json", "--force-full", "--session", session], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).data;
    const shape = (snap) => JSON.stringify(snap.nodes.map((node) => [node.type, node.label, node.value]));
    let last = take();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      execFileSync("sleep", ["0.5"]);
      const next = take();
      const settled = shape(next) === shape(last);
      last = next;
      if (settled) break;
    }
    const keys = ["nodes", "viewport", "truncated", "appName", "appBundleId"];
    const kept = Object.fromEntries(keys.filter((key) => last[key] !== undefined).map((key) => [key, last[key]]));
    require("node:fs").writeFileSync(out, `${JSON.stringify(kept, null, 2)}\n`);
  ' "$CLI" "$SESSION" "$OUT/swiftui-$1.json"
}

capture inbox
"$CLI" press 'label="Open message"' --session "$SESSION" >/dev/null
capture message
"$CLI" back --session "$SESSION" >/dev/null
"$CLI" press 'label="Open untitled"' --session "$SESSION" >/dev/null
capture untitled
"$CLI" back --session "$SESSION" >/dev/null
"$CLI" press 'label="Compose"' --session "$SESSION" >/dev/null
capture compose
