# Native Tern tests

Use `@e2e-dev/tern` only with explicit session ownership. A borrowed single-pane window is already internally focused and is never closed, restarted or desktop-focused. Native actions use fresh AX/tree/dump state and a unique current hit; `getByRole`, labels and actual values use ordinary runner locators. Secure values are omitted. Pure focus is an accessibility action, not a click.

A capture lease is observation-only, truncated text. It cannot perform native actions or keyboards, and is not an AX or native-input proof. Do not silently fall back after a native control error. `ACTION_MAY_HAVE_COMMITTED` must not be replayed; stale identities can be retried by the runner.

Default native modifier delivery is refused. Select a provider with a real isolated keyboard for chords. Never discover the operator's control socket, dispatch host keyboard input, move physical focus, or reuse private profile credentials. Screenshot capture has no secret mask and is not advertised by this engine.

`apps/tern-testbed` is a real SDK fixture with inert controls. Its unit tests complement, not replace, the required real native CI job. The SDK is public; native Tern delivery is currently closed beta. A permitted reproducible pinned executable is a prerequisite, not a mockable test detail. No workstation paths, profiles, private binaries or histories belong in a contribution.
