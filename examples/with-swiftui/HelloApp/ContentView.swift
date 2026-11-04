import Accessibility
import SwiftUI

struct ContentView: View {
    @State private var name = ""
    @State private var showError = false
    @State private var greeted: String?
    @FocusState private var nameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Logotype()
                .fill(Brand.offWhite)
                .frame(width: 69, height: 24)
                .accessibilityElement()
                .accessibilityLabel("e2e")
                .accessibilityAddTraits(.isImage)
                .padding(.vertical, 12)

            Rectangle().fill(Brand.neutral800).frame(height: 1)

            VStack(alignment: .leading, spacing: 0) {
                Text("[ with-swiftui ]")
                    .font(Brand.mono(12))
                    .tracking(0.48)
                    .foregroundStyle(Brand.green)
                Text("say hello")
                    .font(Brand.sans(39))
                    .tracking(-1.17)
                    .foregroundStyle(Brand.offWhite)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 8)
                Text("A demo screen for the e2e examples. Type a name and the app greets you.")
                    .font(Brand.sans(18))
                    .lineSpacing(7)
                    .foregroundStyle(Brand.neutral500)
                    .padding(.top, 24)

                VStack(alignment: .leading, spacing: 16) {
                    // The design system's text field: the label sits inside the field, above the value.
                    VStack(alignment: .leading, spacing: 4) {
                        Text("name")
                            .font(Brand.mono(12))
                            .foregroundStyle(Brand.neutral400)
                            // The field carries the name for assistive tech.
                            .accessibilityHidden(true)
                        // accessibilityIdentifier is what getByTestId finds.
                        TextField("", text: $name)
                            .accessibilityIdentifier("name")
                            .accessibilityLabel("name")
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .focused($nameFocused)
                            .onSubmit(greet)
                            .font(Brand.sans(16))
                            .foregroundStyle(Brand.offWhite)
                            .tint(Brand.offWhite)
                    }
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                    .background(Brand.neutral800)
                    .overlay(Rectangle().strokeBorder(fieldOutline, lineWidth: 2))
                    .contentShape(Rectangle())
                    .onTapGesture { nameFocused = true }

                    Button(action: greet) {
                        Text("greet")
                            .font(Brand.mono(15))
                            .foregroundStyle(Brand.offWhite)
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(Brand.blue)
                    }
                    .buttonStyle(PressScale())
                    .accessibilityIdentifier("greet")

                    if showError {
                        Text("enter a name first.")
                            .font(Brand.sans(14))
                            .foregroundStyle(Brand.mint)
                            .accessibilityIdentifier("error")
                    }

                    if let greeted {
                        Text("hello, \(greeted)!")
                            .font(Brand.sans(16))
                            .foregroundStyle(Brand.offWhite)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Brand.neutral800)
                            .accessibilityIdentifier("greeting")
                    }
                }
                .padding(.top, 40)
            }
            .padding(.top, 48)

            Spacer()
        }
        .padding(.horizontal, 24)
        .background(Brand.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    /// Focus and the error change the outline's colour only, so nothing moves.
    private var fieldOutline: Color {
        if showError { return Brand.mint }
        return nameFocused ? Brand.green : .clear
    }

    private func greet() {
        nameFocused = false
        let value = name.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else {
            showError = true
            greeted = nil
            AccessibilityNotification.Announcement("enter a name first.").post()
            return
        }
        showError = false
        greeted = value
        name = ""
    }
}

/// Buttons change no colour when pressed; a press scales them a little.
private struct PressScale: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

/// The e2e logotype, drawn from the official logo's bars so it stays sharp at any size.
private struct Logotype: Shape {
    private static let size = CGSize(width: 407, height: 142)
    private static let bars: [CGRect] = [
        CGRect(x: 155.91, y: 0, width: 90.24, height: 19.06),
        CGRect(x: 26.94, y: 24.48, width: 82.4, height: 19.09),
        CGRect(x: 145.32, y: 24.48, width: 35.83, height: 19.09),
        CGRect(x: 220.91, y: 24.48, width: 35.84, height: 19.09),
        CGRect(x: 297.82, y: 24.48, width: 82.43, height: 19.09),
        CGRect(x: 10.59, y: 49.04, width: 32.69, height: 19.05),
        CGRect(x: 92.79, y: 49.04, width: 33.14, height: 19.05),
        CGRect(x: 210.32, y: 49.04, width: 35.83, height: 19.05),
        CGRect(x: 281.46, y: 49.04, width: 32.69, height: 19.05),
        CGRect(x: 363.66, y: 49.04, width: 33.18, height: 19.05),
        CGRect(x: 0, y: 73.54, width: 135.96, height: 19.08),
        CGRect(x: 185.09, y: 73.54, width: 35.8, height: 19.08),
        CGRect(x: 270.88, y: 73.54, width: 135.97, height: 19.08),
        CGRect(x: 4.13, y: 98.07, width: 32.68, height: 19.05),
        CGRect(x: 158.07, y: 98.04, width: 35.83, height: 19.08),
        CGRect(x: 274.98, y: 98.07, width: 32.68, height: 19.05),
        CGRect(x: 26.94, y: 122.57, width: 82.4, height: 19.05),
        CGRect(x: 145.32, y: 122.57, width: 113.33, height: 19.05),
        CGRect(x: 297.82, y: 122.57, width: 82.43, height: 19.05),
    ]

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / Self.size.width, rect.height / Self.size.height)
        var path = Path()
        for bar in Self.bars {
            path.addRect(bar.applying(CGAffineTransform(scaleX: scale, y: scale)).offsetBy(dx: rect.minX, dy: rect.minY))
        }
        return path
    }
}

/// e2e design system: black canvas, square corners, e2e blue for the one action, green and mint
/// accents, an 8pt spacing grid, and lowercase headings and UI. Inter and JetBrains Mono stand in
/// for the brand's own typefaces.
private enum Brand {
    static let black = Color(hex: 0x000000)
    static let offWhite = Color(hex: 0xF7F7F7)
    static let neutral800 = Color(hex: 0x1C1C1C)
    static let neutral500 = Color(hex: 0x8D8D8D)
    static let neutral400 = Color(hex: 0xB1B1B1)
    static let blue = Color(hex: 0x1A5FFF)
    static let green = Color(hex: 0x64FF9D)
    static let mint = Color(hex: 0x8AF9FF)

    static func sans(_ size: CGFloat) -> Font { .custom("Inter-Regular", fixedSize: size) }
    static func mono(_ size: CGFloat) -> Font { .custom("JetBrainsMono-Regular", fixedSize: size) }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

#Preview {
    ContentView()
}
