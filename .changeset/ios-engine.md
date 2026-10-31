---
'@e2e-dev/ios': patch
---

Add `@e2e-dev/ios`, an experimental native iOS simulator engine: an engine protocol server in Swift, hosted by XCUITest on the simulator, without agent-device. The first run builds the server with Xcode into `~/Library/Caches/e2e/ios-server`; `npx e2e-ios-build` builds it ahead of time.
