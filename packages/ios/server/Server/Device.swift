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

  /// One observed node: where it was, and how XCUITest can find it again.
  struct Observed {
    let frame: CGRect
    let type: XCUIElement.ElementType
    let value: String?
    let checked: Bool?
    let identifier: String
    let label: String
    /// The process that hosts the node: the app's, or another's whose view the app shows, such as a system sheet.
    let pid: Int32?
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
      fresh[id] = Observed(frame: node.frame, type: node.elementType, value: value, checked: checked, identifier: node.identifier, label: node.label, pid: Device.processIdentifier(node))
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

  /// Refuses a node tapped at a point when the app has moved it since the
  /// observation: with the app idle, a fresh snapshot must still have a
  /// node of its type, identifier, and label at its frame. A list still
  /// coasting from a fling when the screen was read fails this, and the
  /// harness resolves the locator again.
  private func unmoved(_ node: Observed, _ id: String, _ app: XCUIApplication) throws {
    func same(_ fresh: XCUIElementSnapshot) -> Bool {
      if fresh.elementType == node.type, fresh.frame == node.frame, fresh.identifier == node.identifier, fresh.label == node.label { return true }
      return fresh.children.contains(where: same)
    }
    if !same(try app.snapshot()) { throw EngineFailure.stale(id) }
  }

  // MARK: actions

  func perform(_ id: String, _ action: [String: Any], _ operation: Operation) throws {
    try operation.check()
    let app = try requireApp()
    let kind = action["kind"] as? String ?? ""
    if id == "root" {
      guard kind == "swipe" else { throw EngineFailure.unsupported("the screen root only takes a swipe") }
      try swipe(in: app.frame, direction: action["direction"] as? String ?? "down", momentum: action["momentum"] as? String, app, operation)
      return
    }
    guard let node = nodes[id] else { throw EngineFailure.stale(id) }
    // A view another process presents over the app (a system sheet)
    // animates there, where the app's own idle wait does not look.
    if let pid = node.pid, pid != Device.processIdentifier(app) { Idle.wait(Device.hostProcess(pid), timeout: operation.seconds) }
    let target = element(node, app)
    // Read once the app is idle, so a list still coasting from a step swipe has stopped.
    Idle.wait(Idle.process(app), timeout: operation.seconds)
    if let target {
      // A row a list unmounted while it coasted is gone, not at its old point.
      if !target.exists { throw EngineFailure.stale(id) }
    } else {
      try unmoved(node, id, app)
    }
    let center = try actionable(node.frame, id, app)
    let tap = {
      try self.event(app, operation) { if let target, target.exists { target.tap() } else { self.coordinate(center, app).tap() } }
    }
    switch kind {
    case "tap", "focus":
      try tap()
    case "doubleTap":
      try event(app, operation) { if let target, target.exists { target.doubleTap() } else { coordinate(center, app).doubleTap() } }
    case "longPress":
      let duration = (action["durationMs"] as? Double ?? 800) / 1000
      try event(app, operation) { if let target, target.exists { target.press(forDuration: duration) } else { coordinate(center, app).press(forDuration: duration) } }
    case "check", "uncheck":
      guard let checked = node.checked else { throw EngineFailure.unsupported("node \(id) reports no checked state") }
      if checked != (kind == "check") { try tap() }
    case "fill", "clear":
      guard node.type == .textField || node.type == .secureTextField || node.type == .searchField || node.type == .textView else {
        throw EngineFailure.notActionable("node \(id) does not take text")
      }
      try tap()
      if node.type == .secureTextField {
        // iOS empties a secure field on the first keystroke after it takes
        // focus, so typing replaces it; a clear types one character and
        // deletes it.
        try type(kind == "fill" ? action["value"] as? String ?? "" : "x" + XCUIKeyboardKey.delete.rawValue, app, operation)
        return
      }
      let existing = node.value?.count ?? 0
      if existing > 0 { try type(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing), app, operation) }
      if kind == "fill" { try type(action["value"] as? String ?? "", app, operation) }
    case "press":
      if node.type == .textField || node.type == .secureTextField || node.type == .textView { try tap() }
      try press(action["key"] as? String ?? "", operation)
    case "swipe":
      try swipe(in: node.frame, direction: action["direction"] as? String ?? "down", momentum: action["momentum"] as? String, app, operation)
    default:
      throw EngineFailure.unsupported("the \"\(kind)\" action is not supported")
    }
  }

  func performAt(_ point: CGPoint, _ action: [String: Any], _ operation: Operation) throws {
    try operation.check()
    let app = try requireApp()
    let at = coordinate(point, app)
    switch action["kind"] as? String ?? "" {
    case "tap": try event(app, operation) { at.tap() }
    case "doubleTap": try event(app, operation) { at.doubleTap() }
    case "longPress": try event(app, operation) { at.press(forDuration: (action["durationMs"] as? Double ?? 800) / 1000) }
    case "dragTo", "swipeTo":
      let target = action["target"] as? [String: Any] ?? [:]
      let end = coordinate(CGPoint(x: target["x"] as? Double ?? 0, y: target["y"] as? Double ?? 0), app)
      let hold = action["kind"] as? String == "dragTo" ? 0.6 : 0.05
      try event(app, operation) { at.press(forDuration: hold, thenDragTo: end) }
    case "swipe":
      let size = app.frame.size
      let half = min(size.width, size.height) / 4
      try swipe(in: CGRect(x: point.x - half, y: point.y - half, width: half * 2, height: half * 2), direction: action["direction"] as? String ?? "down", momentum: action["momentum"] as? String, app, operation)
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
        try type("x" + XCUIKeyboardKey.delete.rawValue, app, operation)
      } else if let value = focused.value as? String, !value.isEmpty, value != focused.placeholderValue {
        try type(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count), app, operation)
      }
    }
    try type(text, app, operation)
  }

  func press(_ key: String, _ operation: Operation) throws {
    try operation.check()
    let app = try requireApp()
    if key.count > 1, key.contains("+") {
      let modifier = key.split(separator: "+").first.map(String.init) ?? key
      throw EngineFailure.unsupported("the soft keyboard cannot hold \(modifier) (\(key))")
    }
    switch key {
    case "Enter": try type("\n", app, operation)
    case "Tab": try type("\t", app, operation)
    case "Backspace": try type(XCUIKeyboardKey.delete.rawValue, app, operation)
    case "Space": try type(" ", app, operation)
    default:
      guard key.count == 1 else { throw EngineFailure.unsupported("the soft keyboard cannot press \(key)") }
      try type(key, app, operation)
    }
  }

  /// Back is the edge swipe a person makes: from the left edge across the screen.
  func back(_ operation: Operation) throws {
    try operation.check()
    let app = try requireApp()
    let size = app.frame.size
    let from = coordinate(CGPoint(x: 2, y: size.height / 2), app)
    try event(app, operation) { from.press(forDuration: 0.05, thenDragTo: coordinate(CGPoint(x: size.width * 0.75, y: size.height / 2), app)) }
  }

  /// Runs one XCUITest gesture once the app is idle (`Idle`), with
  /// XCUITest's own idle waits around it turned off through its interaction
  /// options: the engine's wait replaces the one before, and the next
  /// action's replaces the one after.
  private func event(_ app: XCUIApplication, _ operation: Operation, _ body: () -> Void) throws {
    try operation.check()
    Idle.wait(Idle.process(app), timeout: operation.seconds)
    let selector = NSSelectorFromString("_performWithInteractionOptions:block:")
    guard app.responds(to: selector) else {
      body()
      return
    }
    let perform = unsafeBitCast(app.method(for: selector), to: (@convention(c) (AnyObject, Selector, UInt, @convention(block) () -> Void) -> Void).self)
    // XCUIApplicationInteractionOptionSkipPreEventQuiescence | SkipPostEventQuiescence.
    withoutActuallyEscaping(body) { body in perform(app, selector, 0b11, body) }
  }

  /// Types `text` as one XCUITest event (see `event`).
  private func type(_ text: String, _ app: XCUIApplication, _ operation: Operation) throws {
    try event(app, operation) { app.typeText(text) }
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

  /// The process that hosts a snapshot node, read off its accessibility element.
  private static func processIdentifier(_ node: XCUIElementSnapshot) -> Int32? {
    ((node as? NSObject)?.value(forKeyPath: "accessibilityElement.processIdentifier") as? NSNumber)?.int32Value
  }


  private static func processIdentifier(_ app: XCUIApplication) -> Int32? {
    ((app as NSObject).value(forKey: "processID") as? NSNumber)?.int32Value
  }

  /// XCTest's handle on another process whose views the app shows, such as a system sheet.
  private static func hostProcess(_ pid: Int32) -> NSObject? {
    guard let monitor = (XCUIDevice.shared as NSObject).value(forKey: "applicationMonitor") as? NSObject else { return nil }
    let lookup = NSSelectorFromString("monitoredApplicationWithProcessIdentifier:")
    guard monitor.responds(to: lookup) else { return nil }
    let find = unsafeBitCast(monitor.method(for: lookup), to: (@convention(c) (AnyObject, Selector, Int32) -> NSObject?).self)
    return find(monitor, lookup, pid)?.value(forKey: "currentProcess") as? NSObject
  }




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
  private func swipe(in frame: CGRect, direction: String, momentum: String?, _ app: XCUIApplication, _ operation: Operation) throws {
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
    // `none` ends at rest. `fast` flings, and waits for the content to
    // stop. `slow` steps through content: it releases at the speed of
    // XCUITest's default drag (about 400 points a second), so the content
    // coasts as far, after covering most of the travel quickly, and waits
    // for the app neither before nor after: a long list coasts and renders
    // for seconds, the next step's touch catches it as a finger would, and
    // the harness reads the screen after every step. An action on a node
    // checks it is still where it was read (`settle`, `unmoved`).
    let towards = CGPoint(x: from.x + (to.x - from.x) * 0.85, y: from.y + (to.y - from.y) * 0.85)
    switch momentum {
    case "none": try Gesture.drag(from: from, path: [(to, 0.3)], hold: 0.1, idleBefore: true, idleAfter: false, timeout: operation.seconds, app)
    case "fast": try Gesture.drag(from: from, path: [(to, 0.2)], hold: 0, idleBefore: true, idleAfter: true, timeout: operation.seconds, app)
    default: try Gesture.drag(from: from, path: [(towards, 0.15), (to, 0.35)], hold: 0, idleBefore: false, idleAfter: false, timeout: operation.seconds, app)
    }
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
