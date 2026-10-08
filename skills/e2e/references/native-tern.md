# Native Tern tests

Use `@e2e-dev/tern` only with explicit session ownership. A borrowed single-pane window is already internally focused and is never closed, restarted or desktop-focused. Native actions use fresh AX/tree/dump state and a unique current hit; `getByRole`, labels and actual values use ordinary runner locators. Secure values are omitted. Pure focus is an accessibility action, not a click.

A capture lease is observation-only, truncated text. It cannot perform native actions or keyboards, and is not an AX or native-input proof. Do not silently fall back after a native control error. `ACTION_MAY_HAVE_COMMITTED` must not be replayed; stale identities can be retried by the runner.

Default native modifier delivery is refused. Select a provider with a real isolated keyboard for chords. Never discover the operator's control socket, dispatch host keyboard input, move physical focus, or reuse private profile credentials. Screenshot capture has no secret mask and is not advertised by this engine.

`apps/tern-testbed` is a real SDK fixture with inert controls. Its unit tests complement, not replace, the required real native CI job. The SDK is public; native Tern delivery is currently closed beta. A permitted reproducible pinned executable is a prerequisite, not a mockable test detail. No workstation paths, profiles, private binaries or histories belong in a contribution.

Native Tern 0.6 must explicitly report `state.gate.applies === false` before and after app observation/input/capture. Active or unknown vendor gates are a hard stop, even if AX exposes underlying controls. A vendor-supported licensed/preprovisioned isolated test profile is a separate prerequisite from executable delivery. Never automate sign-in/account actions, copy live host credentials or use underlying AX to bypass a covering gate. Fresh empty provider profiles may remain blocked until that prerequisite is supplied.

## Owned Linux input

Use `@e2e-dev/sway.sway` for a fresh headless pixman compositor and private runtime/profile. Pin absolute binary paths and explicitly build the shipped C source with its `build-input.mjs` script; no install hook, service change or permission grant is required. Input binds the generated seat by exact name, creates and retains keyboard/pointer capabilities before Tern starts, and rejects a missing manager or mismatched client generation. Never take the first available seat or sleep to pretend a client is ready.

Run the owned fixture through `e2e.sway.config.ts` with explicit `E2E_SWAY_BINARY`, `E2E_SWAYMSG_BINARY`, `E2E_GRIM_BINARY`, `E2E_TERN_BINARY` and `E2E_INPUT_BINARY`. Control+A must actually replace the native editor's selected text; following ordinary text must prove modifier release. The counter must change from a named-seat pointer click on that surviving client. A zero exit code is not that proof. The separate lifecycle fixture kills only its fresh worker and requires target-finish sweep to remove the recorded native client and sockets. Capture is opt-in and unmasked; keep real application artifacts private.
