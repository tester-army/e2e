# e2e with Expo

An Expo greeting app with three locator tests and two agent tests per platform.

## Run

Use Node 22.22.3+, 24.8+, or 26+. From this folder:

```bash
npm install
```

Choose one platform:

| Platform | Build and install | Run tests |
| --- | --- | --- |
| Web | The runner starts Expo | `npm run test:e2e:web` |
| iOS | `npm run ios:release` | `npm run test:e2e:ios` |
| Android | `npm run android:release` | `npm run test:e2e:android` |

For native builds, follow [Expo's setup guide](https://docs.expo.dev/get-started/set-up-your-environment/).
Start a simulator or emulator before building. Rebuild after app changes.
After config changes, run `npx expo prebuild` to update existing native projects.

## Agent tests

Set a [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key:

```bash
AI_GATEWAY_API_KEY="your-key" npm run test:e2e:web
```

Use `test:e2e:ios` or `test:e2e:android` for native tests.
Without the key, the agent tests skip. Add `-- --no-cache` to use fresh
model calls. Results are in `.e2e/report.json`.

See [e2e.config.ts](e2e.config.ts) and [tests/](tests/) for the setup.
For your own app, follow the [Quickstart](https://e2e.tester.army/docs/quickstart).

Last checked on 2026-10-05 with Expo SDK 57, e2e 0.16.0,
@e2e-dev/web 0.11.2 and @e2e-dev/mobile 0.9.2.
