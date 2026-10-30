import Foundation
import ObjectiveC

/// XCUITest waits for the app to go idle before and after every gesture:
/// no animation, no pending main-queue work. After a scroll that wait lasts
/// as long as the content coasts, most of a swipe's cost. The server wraps
/// XCTest's private wait so it can be skipped: around scroll swipes always
/// (the harness reads the screen again after each one, and the next tap
/// still waits before its event), and everywhere with `E2E_WAIT_FOR_IDLE=0`,
/// as WebDriverAgent does. Private API: it can break with any Xcode release.
enum Quiescence {
  /// True while the wait is skipped.
  private(set) static var skipping = ProcessInfo.processInfo.environment["E2E_WAIT_FOR_IDLE"] == "0"
  /// Whether XCTest's wait could be wrapped; when not, gestures keep it.
  private(set) static var installed = false

  /// Wraps XCTest's wait. False when the wait was asked off for every
  /// gesture and could not be: the server must not run with a setting it
  /// cannot honor. A wait that cannot be wrapped otherwise only costs time.
  static func install() -> Bool {
    if let process = NSClassFromString("XCUIApplicationProcess") {
      let one = wrap(process, "waitForQuiescenceIncludingAnimationsIdle:") { (original: IMP) in
        let call = unsafeBitCast(original, to: (@convention(c) (AnyObject, Selector, Bool) -> Void).self)
        let block: @convention(block) (AnyObject, Bool) -> Void = { this, idle in
          if !skipping { call(this, NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:"), idle) }
        }
        return imp_implementationWithBlock(block)
      }
      let two = wrap(process, "waitForQuiescenceIncludingAnimationsIdle:isPreEvent:") { (original: IMP) in
        let call = unsafeBitCast(original, to: (@convention(c) (AnyObject, Selector, Bool, Bool) -> Void).self)
        let block: @convention(block) (AnyObject, Bool, Bool) -> Void = { this, idle, preEvent in
          if !skipping { call(this, NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:"), idle, preEvent) }
        }
        return imp_implementationWithBlock(block)
      }
      installed = one || two
    }
    return installed || !skipping
  }

  /// Runs `body` without XCTest's idle wait, when it could be wrapped.
  static func skipped<T>(_ body: () throws -> T) rethrows -> T {
    let was = skipping
    skipping = installed || was
    defer { skipping = was }
    return try body()
  }

  private static func wrap(_ type: AnyClass, _ selector: String, _ replacement: (IMP) -> IMP) -> Bool {
    guard let method = class_getInstanceMethod(type, NSSelectorFromString(selector)) else { return false }
    method_setImplementation(method, replacement(method_getImplementation(method)))
    return true
  }
}
