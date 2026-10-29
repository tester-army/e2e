import Foundation
import ObjectiveC

/// XCUITest waits for the app to go idle before and after every gesture:
/// no animation, no pending main-queue work. That wait is most of a tap's
/// cost. With `E2E_WAIT_FOR_IDLE=0` the server replaces XCTest's private
/// wait with a no-op, as WebDriverAgent does, and a gesture returns once its
/// events are delivered; the harness's own polling then waits for the
/// outcome. Private API: it can break with any Xcode release.
enum Quiescence {
  /// False when the wait was asked off and none of XCTest's waits could be
  /// replaced: the server must not run with a setting it cannot honor.
  static func disableIfAsked() -> Bool {
    guard ProcessInfo.processInfo.environment["E2E_WAIT_FOR_IDLE"] == "0" else { return true }
    guard let process = NSClassFromString("XCUIApplicationProcess") else { return false }
    let oneArgument: @convention(block) (AnyObject, Bool) -> Void = { _, _ in }
    let twoArguments: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
    let replacedOne = replace(process, "waitForQuiescenceIncludingAnimationsIdle:", with: imp_implementationWithBlock(oneArgument))
    let replacedTwo = replace(process, "waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", with: imp_implementationWithBlock(twoArguments))
    return replacedOne || replacedTwo
  }

  private static func replace(_ type: AnyClass, _ selector: String, with implementation: IMP) -> Bool {
    guard let method = class_getInstanceMethod(type, NSSelectorFromString(selector)) else { return false }
    method_setImplementation(method, implementation)
    return true
  }
}
