import SwiftUI

struct ContentView: View {
    @State private var name = ""
    @State private var showError = false
    @State private var greeted: String?
    @FocusState private var nameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image("HelmetMark")
                    .resizable()
                    .frame(width: 32, height: 32)
                    .accessibilityLabel("e2e")
                Text("/").font(Brand.mono(26))
                Text("e2e").font(Brand.display(26)).tracking(-1.5)
            }
            .foregroundStyle(Brand.textPrimary)
            .padding(.vertical, 20)

            Rectangle().fill(Brand.hairline).frame(height: 0.5)

            VStack(alignment: .leading, spacing: 16) {
                Text("[01] with-swiftui")
                    .font(Brand.mono(12))
                    .tracking(0.6)
                    .textCase(.uppercase)
                    .foregroundStyle(Brand.textSecondary)
                Text("Say hello")
                    .font(Brand.display(38))
                    .foregroundStyle(Brand.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text("A demo screen for the e2e examples. Type a name and the app greets you.")
                    .font(Brand.sans(16))
                    .lineSpacing(4)
                    .foregroundStyle(Brand.textSecondary)

                VStack(alignment: .leading, spacing: 12) {
                    Text("Name")
                        .font(Brand.mono(11))
                        .tracking(1.1)
                        .textCase(.uppercase)
                        .foregroundStyle(Brand.textFaint)

                    // accessibilityIdentifier is what getByTestId finds.
                    TextField("Name", text: $name, prompt: Text("Ada Lovelace").foregroundStyle(Brand.textFaint))
                        .accessibilityIdentifier("name")
                        // The prompt is not a name; without this the field reads as an unnamed textbox.
                        .accessibilityLabel("Name")
                        .autocorrectionDisabled()
                        .focused($nameFocused)
                        .onSubmit(greet)
                        .font(Brand.mono(14))
                        .foregroundStyle(Brand.textPrimary)
                        .padding(.horizontal, 12)
                        .frame(height: 44)
                        .background(Brand.fieldFill)
                        .overlay(Rectangle().stroke(Brand.fieldStroke, lineWidth: 0.5))

                    Button(action: greet) {
                        Text("Greet")
                            .font(Brand.mono(13))
                            .textCase(.uppercase)
                            .foregroundStyle(Brand.textOnLight)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(Brand.buttonFill)
                    }
                    .accessibilityIdentifier("greet")

                    if showError {
                        Text("Enter a name first.")
                            .font(Brand.sans(14))
                            .foregroundStyle(Brand.accent)
                            .accessibilityIdentifier("error")
                    }

                    if let greeted {
                        Text("Hello, \(greeted)!")
                            .font(Brand.sans(14))
                            .foregroundStyle(Brand.textPrimary)
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Brand.panel)
                            .overlay(Rectangle().stroke(Brand.hairline, lineWidth: 0.5))
                            .accessibilityIdentifier("greeting")
                    }
                }
                .padding(.top, 24)
            }
            .padding(.top, 48)

            Spacer()
        }
        .padding(.horizontal, 24)
        .background(Brand.canvas.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private func greet() {
        nameFocused = false
        let value = name.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else {
            showError = true
            greeted = nil
            return
        }
        showError = false
        greeted = value
        name = ""
    }
}

/// e2e brand: dark canvas, square corners, hairlines instead of shadows, white text at falling alphas.
private enum Brand {
    static let canvas = Color(hex: 0x111111)
    static let panel = Color(hex: 0x161616)
    static let fieldFill = Color(hex: 0x1A1A1A)
    static let buttonFill = Color(hex: 0xF9F8F7)
    static let textPrimary = Color(hex: 0xF9F8F7)
    static let textOnLight = Color(hex: 0x161616)
    static let textSecondary = Color.white.opacity(0.7)
    static let textFaint = Color.white.opacity(0.5)
    static let hairline = Color.white.opacity(0.12)
    static let fieldStroke = Color.white.opacity(0.3)
    static let accent = Color(hex: 0xFF8001)

    static func display(_ size: CGFloat) -> Font { .custom("StackSansNotch-Regular", fixedSize: size) }
    static func sans(_ size: CGFloat) -> Font { .custom("Inter-Regular", fixedSize: size) }
    static func mono(_ size: CGFloat) -> Font { .custom("DMMono-Regular", fixedSize: size) }
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
