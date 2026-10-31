import XCTest

/// The engine's wait for a process to be ready for an event, from XCTest's
/// own two signals, asked for one at a time: its main run loop is idle,
/// then its animations are. XCUITest's built-in wait asks for both at once
/// and gives up only after a minute; an app that keeps an animation running
/// (seen after a web view's form control took a tap) never reports the
/// second, so every action would stall that long. The run loop wait is
/// bounded by the operation; the animation wait by `animationLimit`.
enum Idle {
  /// How long an animation may run before the event goes anyway, in
  /// seconds: over twice the longest finite one the mobile benchmark waited
  /// for (1.2 s; p99 0.4 s), and far below XCTest's minute.
  static let animationLimit = 3.0

  /// XCTest's handle on a process, for `wait`.
  static func process(_ app: XCUIApplication) -> NSObject? {
    (app as NSObject).value(forKey: "currentProcess") as? NSObject
  }

  /// Waits for a foreground `process` to idle its run loop (within `timeout`
  /// seconds) and then its animations (within `animationLimit`).
  static func wait(_ process: NSObject?, timeout: Double) {
    // Only a foreground process takes events and answers for its idle
    // state; a background one (a web view's content process) never replies.
    guard let process, process.responds(to: NSSelectorFromString("foreground")), process.value(forKey: "foreground") as? Bool == true else { return }
    notified(process, "_notifyWhenMainRunLoopIsIdle:", within: timeout)
    notified(process, "_notifyWhenAnimationsAreIdle:", within: animationLimit)
  }

  /// Asks `process` to call back once idle, and runs the run loop until it
  /// does or `within` seconds pass. False when the time passed first.
  @discardableResult
  private static func notified(_ process: NSObject, _ name: String, within: Double) -> Bool {
    let selector = NSSelectorFromString(name)
    guard process.responds(to: selector) else { return true }
    let state = Reply()
    let ask = unsafeBitCast(process.method(for: selector), to: (@convention(c) (AnyObject, Selector, @escaping @convention(block) (NSError?) -> Void) -> Void).self)
    ask(process, selector) { _ in state.done() }
    let deadline = Date(timeIntervalSinceNow: within)
    while !state.isDone, Date() < deadline {
      RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005))
    }
    return state.isDone
  }

  /// A reply that may arrive on any thread.
  final class Reply: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isDone: Bool {
      lock.lock()
      defer { lock.unlock() }
      return value
    }

    func done() {
      lock.lock()
      value = true
      lock.unlock()
    }
  }
}
