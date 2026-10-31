import Foundation

/// What React Native spells into an iOS accessibility value for the roles
/// UIKit has no trait for: the role description, then state words, then the
/// value proper, comma-separated ("radio button, checked"). XCTest reports
/// such a view as an `Other`; this reads the role and states back, as the
/// mobile engine does.
struct ReactNativeValue {
  private static let roles: [String: String] = [
    "alert": "alert", "checkbox": "checkbox", "combo box": "combobox", "menu": "menu", "menu bar": "menubar",
    "menu item": "menuitem", "progress bar": "progressbar", "radio button": "radio", "radio group": "radiogroup",
    "scroll bar": "scrollbar", "spin button": "spinbutton", "switch": "switch", "tab": "tab", "tab list": "tablist",
    "timer": "timer", "tool bar": "toolbar",
  ]
  /// State words with no contract state: kept in the value, so they still read.
  private static let looseStates: Set<String> = ["mixed", "busy"]

  let role: String
  var checked: Bool?
  var expanded: Bool?
  /// The value proper, after the role and state words; nil when nothing follows them.
  let value: String?

  init?(_ raw: String?) {
    guard let raw else { return nil }
    let parts = raw.components(separatedBy: ", ")
    guard let first = parts.first, let role = Self.roles[first.lowercased()] else { return nil }
    self.role = role
    var rest: [String] = []
    var position = 1
    while position < parts.count {
      let word = parts[position].lowercased()
      if word == "checked" { checked = true } else if word == "unchecked" { checked = false } else if word == "expanded" { expanded = true } else if word == "collapsed" { expanded = false } else if Self.looseStates.contains(word) { rest.append(parts[position]) } else { break }
      position += 1
    }
    rest.append(contentsOf: parts[position...])
    value = rest.isEmpty ? nil : rest.joined(separator: ", ")
  }
}
