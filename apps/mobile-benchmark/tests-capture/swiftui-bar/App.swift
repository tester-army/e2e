// A SwiftUI navigation stack whose bars carry toolbar items, captured into
// packages/mobile/tests/fixtures/snapshots/ios/swiftui-*.json. Hand-run only;
// see capture.sh.

import SwiftUI

@main
struct SwiftUIBarApp: App {
  var body: some Scene {
    WindowGroup { Inbox() }
  }
}

struct Inbox: View {
  @State private var composing = false

  var body: some View {
    NavigationStack {
      List {
        NavigationLink("Open message") { Message() }
        NavigationLink("Open untitled") { Untitled() }
        Button("Compose") { composing = true }
      }
      .navigationTitle("Inbox")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Edit") {} }
        ToolbarItem(placement: .topBarTrailing) { Button("New") {} }
      }
      .sheet(isPresented: $composing) { Compose() }
    }
  }
}

struct Message: View {
  var body: some View {
    Text("Message body")
      .navigationTitle("Message")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Reply") {} }
      }
  }
}

struct Untitled: View {
  var body: some View {
    Text("Untitled body")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Share") {} }
      }
  }
}

struct Compose: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Text("Compose body")
        .navigationTitle("Compose")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) { Button("Send") {} }
        }
    }
  }
}
