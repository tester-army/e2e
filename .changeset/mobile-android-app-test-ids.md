---
"@e2e-dev/mobile": patch
---

`getByTestId` on Android also matches a resource id without its `<package>:id/` prefix when nothing matches the full id, so a .NET MAUI `AutomationId` or a native `android:id` matches the same string as on iOS. A negative check on such a name, like `toHaveCount(0)`, can now see a node it used to miss, and two prefixed views that share the name on one screen are ambiguous.
