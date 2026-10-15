---
"@e2e-dev/mobile": patch
---

`getByTestId` finds an Android view by its resource id without the `<package>:id/` prefix, so a .NET MAUI `AutomationId` or a native `android:id` matches the same string as on iOS, whatever package the build gives its resources. The full id still matches, and framework ids (`android:id/...`) match only in full. Two things change for existing Android suites: a negative check on a bare id that passed because nothing matched, such as `toHaveCount(0)`, now sees the node, and a string that names both a bare id and a prefixed one on the same screen is ambiguous.
