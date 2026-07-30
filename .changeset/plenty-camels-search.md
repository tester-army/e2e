---
'@e2edev/playwright': minor
'e2e': minor
---

Move the Playwright driver into its own `@e2edev/playwright` package.

`e2e` no longer depends on `playwright`, so installs that drive another backend
no longer download a browser. `driver: 'playwright'` still works and is still
the default for web targets; the runner now loads the driver from
`@e2edev/playwright`, which it declares as an optional peer dependency.

**Upgrading:** install the driver alongside the runner.

```bash
npm install --save-dev e2e @e2edev/playwright
```

A target that names the driver without the package installed now fails config
resolution with `DRIVER_NOT_INSTALLED` and exit code 2, naming the package to
install.

Also in this release:

- Drivers can implement an optional `prepare` hook, run once before any session
  launches, for slow one-time provisioning. Browser downloads now happen there,
  so they are never charged against a launch timeout for any driver, not just
  the built-in one. A failing `prepare` aborts the run as an infrastructure
  error instead of a test failure.
- The list reporter now prints run-level errors. Previously a run that failed
  during config, collection, or provisioning exited non-zero with the reason
  only in `report.json`.
- The `e2e/playwright` subpath export is removed; import from
  `@e2edev/playwright` instead.
