import SwiftUI

/// The app a UI test bundle needs as its host. The engine server drives
/// other apps by bundle id; this one only gives the test runner a target.
@main
struct HostApp: App {
  var body: some Scene {
    WindowGroup { Text("e2e iOS engine") }
  }
}
