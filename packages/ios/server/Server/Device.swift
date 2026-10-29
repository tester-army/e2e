import UIKit
import XCTest

/// The manifest the server answers `initialize` with; the host half
/// declares the same at config load, and the client checks they agree.
enum Manifest {
  static let json: [String: Any] = [
    "name": "ios",
    "version": "0.1.0",
    "spiVersion": 1,
    "platform": "ios",
    "workers": 1,
    "methods": [
      "engine/observe", "engine/perform", "engine/performAt", "keyboard/type", "keyboard/press",
      "artifacts/screenshot", "session/back", "session/restart", "lifecycle/init",
      "lifecycle/startAttempt", "lifecycle/endAttempt",
    ],
    "actions": ["tap", "doubleTap", "longPress", "fill", "clear", "press", "check", "uncheck", "focus", "swipe"],
    "pointerActions": ["tap", "doubleTap", "longPress", "dragTo", "swipe", "swipeTo"],
  ]
}

/// The app under test as the engine contract sees it: one observation tree
/// read from an XCUITest snapshot, and input as XCUITest gestures at the
/// observed frames. Coordinates are points, the space frames come in.
final class Device {
  private static let roles: [XCUIElement.ElementType: String] = [
    .button: "button", .staticText: "text", .textField: "textbox", .secureTextField: "textbox",
    .searchField: "textbox", .textView: "textbox", .switch: "switch", .toggle: "switch", .image: "image",
    .icon: "image", .cell: "listitem", .table: "list", .collectionView: "list", .scrollView: "group",
    .navigationBar: "navigation", .tabBar: "tablist", .tab: "tab", .link: "link", .slider: "slider",
    .alert: "alert", .sheet: "dialog", .other: "group", .window: "group", .segmentedControl: "tablist",
    .picker: "combobox", .pickerWheel: "combobox", .stepper: "spinbutton", .webView: "document",
    .checkBox: "checkbox", .radioButton: "radio", .progressIndicator: "progressbar",
    .activityIndicator: "progressbar", .toolbar: "toolbar", .menu: "menu", .menuItem: "menuitem",
    .application: "application", .map: "image",
  ]

  private var app: XCUIApplication?
  private var bundleId: String?
  /// What each node of the newest observation was, by id; ids carry the observation's generation.
  private var nodes: [String: Observed] = [:]
  /// How many nodes of the newest observation share each address, so only a unique one is resolved to an element.
  private var addresses: [String: Int] = [:]
  private var generation = 0
  /// How long a control that arrived with the last action gets to finish arriving; see `arrived`.
  private let transition = (Double(ProcessInfo.processInfo.environment["E2E_TRANSITION_MS"] ?? "") ?? 500) / 1000
  /// When the last action returned, and where each control was in the observation it was resolved from.
  private var lastActionAt = Date.distantPast
  private var beforeAction: [String: CGRect] = [:]

  /// One observed node: where it was, and how XCUITest can find it again.
  struct Observed {
    let frame: CGRect
    let type: XCUIElement.ElementType
    let value: String?
    let checked: Bool?
    let identifier: String
    let label: String
  }

  func initialize(app declared: [String: Any]?, _ operation: Operation) throws {
    bundleId = declared?["bundleId"] as? String
    guard let bundleId else { return }
    let app = XCUIApplication(bundleIdentifier: bundleId)
    self.app = app
    try operation.check()
    if app.state != .runningForeground { app.activate() }
  }

  func startAttempt() {
    nodes = [:]
    addresses = [:]
  }

  func environment() -> [String: String] {
    [
      "platform": "ios",
      "device": UIDevice.current.name,
      "os": "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
      "engine": "ios direct (XCUITest)",
    ]
  }

  private func requireApp() throws -> XCUIApplication {
    guard let app else { throw EngineFailure.unsupported("the ios engine needs the target's app.bundleId") }
    return app
  }

  // MARK: observation

  func observe(pixels: Bool) throws -> [String: Any] {
    let app = try requireApp()
    let snapshot = try app.snapshot()
    let viewport = snapshot.frame
    generation += 1
    var fresh: [String: Observed] = [:]
    var counts: [String: Int] = [:]
    var counter = 0
    var keyboard = false
    var secureFrames: [CGRect] = []

    func convert(_ node: XCUIElementSnapshot) -> [String: Any]? {
      if node.elementType == .keyboard {
        keyboard = true
        return nil
      }
      counter += 1
      let id = "\(generation).\(counter)"
      let raw = node.value.map { "\($0)" }
      // React Native spells the roles UIKit has no trait for into the value
      // of an `Other` ("radio button, checked"); that is the role the app declared.
      let spelled = node.elementType == .other ? ReactNativeValue(raw) : nil
      let role = spelled?.role ?? Device.roles[node.elementType] ?? "group"
      let isSecure = node.elementType == .secureTextField
      // XCTest reports an empty field's placeholder as its value.
      let value = spelled.map { $0.value } ?? (raw == node.placeholderValue ? nil : raw)
      let checked = spelled?.checked ?? (Device.checkable.contains(role) ? Device.checkedValue(value) : nil)
      fresh[id] = Observed(frame: node.frame, type: node.elementType, value: value, checked: checked, identifier: node.identifier, label: node.label)
      for address in Device.addresses(node.elementType, node.identifier, node.label) { counts[address, default: 0] += 1 }
      var out: [String: Any] = ["ref": ["id": id, "revision": ""], "role": role]
      if isSecure { secureFrames.append(node.frame) }
      if !node.label.isEmpty {
        out["name"] = String(node.label.prefix(256))
        out["text"] = String(node.label.prefix(512))
      }
      if !isSecure, let value, !value.isEmpty { out["value"] = String(value.prefix(512)) }
      if !node.identifier.isEmpty { out["testId"] = node.identifier }
      if isSecure { out["inputPurpose"] = "password" }
      var states: [String: Bool] = [:]
      if !node.isEnabled { states["disabled"] = true }
      if node.isSelected { states["selected"] = true }
      if let checked { states["checked"] = checked }
      if spelled?.expanded == true { states["expanded"] = true }
      if isSecure { states["secure"] = true }
      if hasKeyboardFocus(node) { states["focused"] = true }
      // Off the screen is hidden, as a person sees it: scrolling brings it in.
      if node.frame.isEmpty || !node.frame.intersects(viewport) { states["hidden"] = true }
      if !states.isEmpty { out["states"] = states }
      out["rect"] = ["x": node.frame.minX, "y": node.frame.minY, "width": node.frame.width, "height": node.frame.height]
      if let placeholder = node.placeholderValue, !placeholder.isEmpty { out["attributes"] = ["placeholder": placeholder] }
      let children = node.children.compactMap(convert)
      if !children.isEmpty { out["children"] = children }
      return out
    }

    let tree = node(snapshot.children.compactMap(convert))
    nodes = fresh
    addresses = counts
    let size = snapshot.frame.size
    var result: [String: Any] = [
      "root": tree.merging(["rect": ["x": 0, "y": 0, "width": size.width, "height": size.height]]) { $1 },
      "viewport": ["width": size.width, "height": size.height],
      "keyboardVisible": keyboard,
      "location": bundleId ?? "",
    ]
    if pixels {
      let capture = XCUIScreen.main.screenshot().image
      // A field that appeared or moved during the capture is masked too.
      for frame in try self.secureFrames() where !secureFrames.contains(frame) { secureFrames.append(frame) }
      let image = masked(capture, secureFrames)
      if let data = image.pngData() {
        result["pixels"] = [
          "data": data.base64EncodedString(), "mediaType": "image/png",
          "width": Int(image.size.width * image.scale), "height": Int(image.size.height * image.scale),
          "scale": Double(image.scale),
        ]
        result["maskedRegionCount"] = secureFrames.count
      }
    }
    return result
  }

  private func node(_ children: [[String: Any]]) -> [String: Any] {
    ["ref": ["id": "root", "revision": ""], "role": "screen", "children": children]
  }

  private static let checkable: Set<String> = ["switch", "checkbox", "radio"]

  /// The checked state a native control spells into its value, or nil when it says none.
  private static func checkedValue(_ value: String?) -> Bool? {
    switch value?.trimmingCharacters(in: .whitespaces).lowercased() {
    case "1", "on", "true", "checked": return true
    case "0", "off", "false", "unchecked": return false
    default: return nil
    }
  }

  /// The ways XCUITest can find a node again: by identifier, else by type and label.
  private static func addresses(_ type: XCUIElement.ElementType, _ identifier: String, _ label: String) -> [String] {
    var keys: [String] = []
    if !identifier.isEmpty { keys.append("id:\(identifier)") }
    if !label.isEmpty { keys.append("label:\(type.rawValue):\(label)") }
    return keys
  }

  /// The node as an element XCUITest resolves itself, when the observation
  /// addresses it uniquely. An element tap finds the hit point, scrolls a
  /// covered element clear (under a sticky footer), and reaches views other
  /// processes host (a system sheet), which a tap at a point cannot.
  private func element(_ node: Observed, _ app: XCUIApplication) -> XCUIElement? {
    let query = app.descendants(matching: node.type)
    if !node.identifier.isEmpty, addresses["id:\(node.identifier)"] == 1 {
      return query.matching(NSPredicate(format: "identifier == %@", node.identifier)).firstMatch
    }
    if !node.label.isEmpty, addresses["label:\(node.type.rawValue):\(node.label)"] == 1 {
      return query.matching(NSPredicate(format: "label == %@", node.label)).firstMatch
    }
    return nil
  }

  /// Lets a control that came with the last action finish arriving, as the
  /// mobile engine does: one already at the same place in the observation
  /// the last action was resolved from is acted on at once; anything else
  /// waits out the rest of the transition budget since that action. A view
  /// presenting reports its final frame from the first frame of the
  /// transition and drops touches until it lands, so time is the only signal.
  private func arrived(_ node: Observed, _ operation: Operation) throws {
    let remaining = transition - Date().timeIntervalSince(lastActionAt)
    guard remaining > 0 else { return }
    if let key = Device.addresses(node.type, node.identifier, node.label).first, beforeAction[key] == node.frame { return }
    let until = Date(timeIntervalSinceNow: remaining)
    while Date() < until {
      try operation.check()
      Thread.sleep(forTimeInterval: min(0.025, until.timeIntervalSinceNow))
    }
  }

  /// Records an action: when it returned, and the observation it was resolved from.
  private func acted() {
    lastActionAt = Date()
    var places: [String: CGRect] = [:]
    for node in nodes.values {
      if let key = Device.addresses(node.type, node.identifier, node.label).first, addresses[key] == 1 { places[key] = node.frame }
    }
    beforeAction = places
  }

  /// Waits for an element that moved since the observation to come to rest:
  /// a sheet still sliding in swallows a tap, and XCUITest's idle wait does
  /// not cover a view another process animates. One where the observation
  /// saw it is acted on at once; otherwise two reads a frame apart must agree.
  private func settle(_ element: XCUIElement, observed: CGRect, _ operation: Operation) throws {
    guard element.exists else { return }
    var current = element.frame
    if current == observed { return }
    let deadline = Date(timeIntervalSinceNow: min(2, operation.timeoutMs / 1000))
    while Date() < deadline {
      try operation.check()
      Thread.sleep(forTimeInterval: 0.05)
      guard element.exists else { return }
      let next = element.frame
      if next == current { return }
      current = next
    }
  }

  // MARK: actions

  func perform(_ id: String, _ action: [String: Any], _ operation: Operation) throws {
    try operation.check()
    let app = try requireApp()
    let kind = action["kind"] as? String ?? ""
    if id == "root" {
      guard kind == "swipe" else { throw EngineFailure.unsupported("the screen root only takes a swipe") }
      defer { acted() }
      try swipe(in: app.frame, direction: action["direction"] as? String ?? "down", momentum: action["momentum"] as? String, app)
      return
    }
    guard let node = nodes[id] else { throw EngineFailure.stale(id) }
    try arrived(node, operation)
    let target = element(node, app)
    if let target { try settle(target, observed: node.frame, operation) }
    let center = try actionable(node.frame, id, app)
    defer { acted() }
    let tap = {
      if let target, target.exists { target.tap() } else { self.coordinate(center, app).tap() }
    }
    switch kind {
    case "tap", "focus":
      tap()
    case "doubleTap":
      if let target, target.exists { target.doubleTap() } else { coordinate(center, app).doubleTap() }
    case "longPress":
      let duration = (action["durationMs"] as? Double ?? 800) / 1000
      if let target, target.exists { target.press(forDuration: duration) } else { coordinate(center, app).press(forDuration: duration) }
    case "check", "uncheck":
      guard let checked = node.checked else { throw EngineFailure.unsupported("node \(id) reports no checked state") }
      if checked != (kind == "check") { tap() }
    case "fill", "clear":
      guard node.type == .textField || node.type == .secureTextField || node.type == .searchField || node.type == .textView else {
        throw EngineFailure.notActionable("node \(id) does not take text")
      }
      tap()
      if node.type == .secureTextField {
        // iOS empties a secure field on the first keystroke after it takes
        // focus, so typing replaces it; a clear types one character and
        // deletes it.
        app.typeText(kind == "fill" ? action["value"] as? String ?? "" : "x" + XCUIKeyboardKey.delete.rawValue)
        return
      }
      let existing = node.value?.count ?? 0
      if existing > 0 { app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing)) }
      if kind == "fill" { app.typeText(action["value"] as? String ?? "") }
    case "press":
      if node.type == .textField || node.type == .secureTextField || node.type == .textView { tap() }
      try press(action["key"] as? String ?? "", operation)
    case "swipe":
      try swipe(in: node.frame, direction: action["direction"] as? String ?? "down", momentum: action["momentum"] as? String, app)
    default:
      throw EngineFailure.unsupported("the \"\(kind)\" action is not supported")
    }
  }

  func performAt(_ point: CGPoint, _ action: [String: Any], _ operation: Operation) throws {
    try operation.check()
    let app = try requireApp()
    defer { acted() }
    let at = coordinate(point, app)
    switch action["kind"] as? String ?? "" {
    case "tap": at.tap()
    case "doubleTap": at.doubleTap()
    case "longPress": at.press(forDuration: (action["durationMs"] as? Double ?? 800) / 1000)
    case "dragTo", "swipeTo":
      let target = action["target"] as? [String: Any] ?? [:]
      let end = coordinate(CGPoint(x: target["x"] as? Double ?? 0, y: target["y"] as? Double ?? 0), app)
      let hold = action["kind"] as? String == "dragTo" ? 0.6 : 0.05
      at.press(forDuration: hold, thenDragTo: end)
    case "swipe":
      let size = app.frame.size
      let half = min(size.width, size.height) / 4
      try swipe(in: CGRect(x: point.x - half, y: point.y - half, width: half * 2, height: half * 2), direction: action["direction"] as? String ?? "down", momentum: action["momentum"] as? String, app)
    default:
      throw EngineFailure.unsupported("the \"\(action["kind"] ?? "")\" action at a point is not supported")
    }
  }

  func type(_ text: String, replace: Bool, _ operation: Operation) throws {
    try operation.check()
    let app = try requireApp()
    if replace {
      let focused = app.descendants(matching: .any).element(matching: NSPredicate(format: "hasKeyboardFocus == true"))
      guard focused.exists else { throw EngineFailure.notActionable("nothing that takes text has focus") }
      if focused.elementType == .secureTextField {
        app.typeText("x" + XCUIKeyboardKey.delete.rawValue)
      } else if let value = focused.value as? String, !value.isEmpty, value != focused.placeholderValue {
        app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
      }
    }
    app.typeText(text)
  }

  func press(_ key: String, _ operation: Operation) throws {
    try operation.check()
    let app = try requireApp()
    if key.count > 1, key.contains("+") {
      let modifier = key.split(separator: "+").first.map(String.init) ?? key
      throw EngineFailure.unsupported("the soft keyboard cannot hold \(modifier) (\(key))")
    }
    switch key {
    case "Enter": app.typeText("\n")
    case "Tab": app.typeText("\t")
    case "Backspace": app.typeText(XCUIKeyboardKey.delete.rawValue)
    case "Space": app.typeText(" ")
    default:
      guard key.count == 1 else { throw EngineFailure.unsupported("the soft keyboard cannot press \(key)") }
      app.typeText(key)
    }
  }

  /// Back is the edge swipe a person makes: from the left edge across the screen.
  func back(_ operation: Operation) throws {
    try operation.check()
    let app = try requireApp()
    defer { acted() }
    let size = app.frame.size
    let from = coordinate(CGPoint(x: 2, y: size.height / 2), app)
    from.press(forDuration: 0.05, thenDragTo: coordinate(CGPoint(x: size.width * 0.75, y: size.height / 2), app))
  }

  func restart(_ operation: Operation) throws {
    try operation.check()
    let app = try requireApp()
    app.terminate()
    app.activate()
  }

  /// A screenshot with every secure field painted over: found from a fresh
  /// snapshot before and after the capture, so a field that appeared or
  /// moved meanwhile is masked too.
  func screenshotBase64() throws -> String {
    let before = try secureFrames()
    let image = XCUIScreen.main.screenshot().image
    let after = try secureFrames()
    guard let data = masked(image, before + after.filter { !before.contains($0) }).pngData() else {
      throw EngineFailure.invalidState("the screen could not be captured")
    }
    return data.base64EncodedString()
  }

  // MARK: helpers

  /// The frames of every secure field in a fresh snapshot of the app.
  private func secureFrames() throws -> [CGRect] {
    guard let app else { return [] }
    var frames: [CGRect] = []
    func walk(_ node: XCUIElementSnapshot) {
      if node.elementType == .secureTextField { frames.append(node.frame) }
      node.children.forEach(walk)
    }
    walk(try app.snapshot())
    return frames
  }

  /// Whether a field holds the keyboard: XCTest's snapshot knows, behind a
  /// property it does not publish, so it is read only where it exists.
  private func hasKeyboardFocus(_ node: XCUIElementSnapshot) -> Bool {
    guard let object = node as? NSObject, object.responds(to: NSSelectorFromString("hasKeyboardFocus")) else { return false }
    return object.value(forKey: "hasKeyboardFocus") as? Bool ?? false
  }

  private func coordinate(_ point: CGPoint, _ app: XCUIApplication) -> XCUICoordinate {
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x, dy: point.y))
  }

  private func actionable(_ frame: CGRect, _ id: String, _ app: XCUIApplication) throws -> CGPoint {
    let visible = frame.intersection(app.frame)
    guard !visible.isNull, !visible.isEmpty else { throw EngineFailure.notActionable("node \(id) is off screen") }
    return CGPoint(x: visible.midX, y: visible.midY)
  }

  /// A scroll gesture inside `frame`: `down` reveals what is below, so the finger travels up.
  private func swipe(in frame: CGRect, direction: String, momentum: String?, _ app: XCUIApplication) throws {
    let dx = frame.width * 0.3
    let dy = frame.height * 0.3
    let center = CGPoint(x: frame.midX, y: frame.midY)
    let (from, to): (CGPoint, CGPoint)
    switch direction {
    case "down": (from, to) = (CGPoint(x: center.x, y: center.y + dy), CGPoint(x: center.x, y: center.y - dy))
    case "up": (from, to) = (CGPoint(x: center.x, y: center.y - dy), CGPoint(x: center.x, y: center.y + dy))
    case "right": (from, to) = (CGPoint(x: center.x + dx, y: center.y), CGPoint(x: center.x - dx, y: center.y))
    case "left": (from, to) = (CGPoint(x: center.x - dx, y: center.y), CGPoint(x: center.x + dx, y: center.y))
    default: throw EngineFailure.unsupported("unknown swipe direction \(direction)")
    }
    let velocity: XCUIGestureVelocity = momentum == "fast" ? .fast : (momentum == "none" ? .slow : .default)
    coordinate(from, app).press(forDuration: 0.05, thenDragTo: coordinate(to, app), withVelocity: velocity, thenHoldForDuration: momentum == "none" ? 0.1 : 0)
  }

  /// Paints secure fields over a capture, so no password leaves the device.
  private func masked(_ image: UIImage, _ frames: [CGRect]) -> UIImage {
    guard !frames.isEmpty else { return image }
    let format = UIGraphicsImageRendererFormat()
    format.scale = image.scale
    return UIGraphicsImageRenderer(size: image.size, format: format).image { context in
      image.draw(at: .zero)
      UIColor.black.setFill()
      for frame in frames { context.fill(frame) }
    }
  }
}
