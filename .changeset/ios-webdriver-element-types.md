---
'@e2e-dev/mobile': patch
---

iOS devices driven through agent-device's WebDriver runtime (hosted Appium clouds such as TestMu AI, BrowserStack, and AWS Device Farm) resolve roles like a local simulator does. That runtime reports XCUITest class names (`XCUIElementTypeButton`, `XCUIElementTypeStaticText`) where the native runner reports `Button` and `StaticText`, and the engine read them as unknown types, so `getByRole('button', 'CPU Load')` matched nothing and `observe` listed the node as `xcuielement-type-button`. The `XCUIElementType` prefix is now dropped before the type is mapped, so a button is a `button`, a tab bar's buttons are `tab`s, and the navigation bar titles the screen.
