import CoreText
import SwiftUI

@main
struct HelloApp: App {
    init() {
        // The brand fonts ship in Fonts/ (SIL OFL, see Fonts/OFL.txt). Registering
        // them here saves an Info.plist entry.
        for url in Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? [] {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
