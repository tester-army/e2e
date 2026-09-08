# @e2edev/cua

The desktop engine for [`@e2edev/e2e`](https://www.npmjs.com/package/@e2edev/e2e), built on
[Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver): native,
Electron, and Tauri apps on macOS, Windows, and Linux through the same
`@e2edev/e2e/engine` contract the browser engine implements. A test written
against `screen`, `expect`, `app`, and `agent` runs on a desktop target
unchanged; nothing in `e2e` core knows this package exists.

## Install

```bash
npm install --save-dev @e2edev/e2e @e2edev/cua
```

The package pins `@trycua/cua-driver`, which installs a native runtime for the
host OS and CPU. On macOS the process that runs the tests needs Accessibility
(observations and actions) and Screen Recording (screenshots) in System
Settings › Privacy & Security; macOS attributes those grants to the terminal,
IDE, or CI agent the tests run from.

```ts title="e2e.config.ts"
import type { E2EConfig } from '@e2edev/e2e';
import { cua } from '@e2edev/cua';

export default {
  targets: [{ name: 'mac', platform: 'macos', engine: cua({ app: 'com.apple.TextEdit' }) }],
  workers: 1,
} satisfies E2EConfig;
```

```ts title="tests/document.e2e.ts"
import { expect } from '@e2edev/e2e';
import { test } from '@e2edev/cua';

test('a new document takes text', async ({ app, screen, desktop }) => {
  await app.open();
  await desktop.menu(['File', 'New']);
  await screen.getByRole('textbox').first().fill('Hello from e2e');
  await expect(screen.getByRole('textbox').first()).toHaveValue('Hello from e2e');
});
```

Options:

| Option | Meaning |
| --- | --- |
| `app` | Bundle identifier or display name of the app launched fresh per attempt and quit after it. |
| `args`, `urls` | Launch arguments and files or URLs to open. |
| `window` | Title (substring or RegExp) of the window to observe; the first on-screen window otherwise. |
| `identity`, `environment` | Trace-cache identity (defaults to `app`) and report label. |
| `maxElements`, `maxDepth` | Caps on the accessibility walk per observation. |

## What the engine declares

`observe` (the window's accessibility tree with roles mapped onto the shared
vocabulary, optional redacted pixels), `locate` (every `screen` query plus
`screen.locator('role=AXButton label="Save"')`), `perform` (`tap`, `doubleTap`,
`fill`, `clear`, `press`, `check`/`uncheck`, `selectOption` by label, `hover`,
`dragTo`, node `swipe`, `focus` on fields), viewport `swipe`, `app.restart`,
`artifacts.screenshot`, and the `url` anchor `app://desktop/<app>/<window>`.
`longPress`, `scrollIntoView`, `setInputFiles`, `app.back`, `app.clearState`,
and state capture are not declared.

The contributed `desktop` fixture adds `locator(selector)`, `menu(path)`,
`hotkey(chord)`, and `window()`.

Full reference: [e2e.docs.buildwithfern.com/reference/desktop](https://e2e.docs.buildwithfern.com/reference/desktop).

## Development

```bash
pnpm --filter @e2edev/cua test:unit        # scripted driver, no permissions needed
E2E_CUA_DESKTOP=1 pnpm --filter @e2edev/cua test:desktop   # drives TextEdit on this Mac
```
