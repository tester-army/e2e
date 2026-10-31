import XCTest

/// A touch gesture sent as one event record through XCTest's private event
/// synthesis, the path its own gestures take, with timing XCUITest's public
/// gestures do not offer: a drag that ends at rest, or one that releases at
/// a given speed without spending the whole travel at it.
enum Gesture {
  /// One finger: down at `from`, along `path` (each point reached at its
  /// offset in seconds), held still `hold` seconds, lifted. Waits for the
  /// app to go idle (`Idle`, within `timeout` seconds) before the event when
  /// `idleBefore`, and after it when `idleAfter`.
  static func drag(from: CGPoint, path: [(CGPoint, Double)], hold: Double, idleBefore: Bool, idleAfter: Bool, timeout: Double, _ app: XCUIApplication) throws {
    let touch = try make("XCPointerEventPath", "initForTouchAtPoint:offset:") { (fn: @convention(c) (AnyObject, Selector, CGPoint, Double) -> Unmanaged<NSObject>, object, selector) in
      fn(object, selector, from, 0)
    }
    for (point, offset) in path {
      send(touch, "moveToPoint:atOffset:") { (fn: @convention(c) (AnyObject, Selector, CGPoint, Double) -> Void, selector) in fn(touch, selector, point, offset) }
    }
    let end = (path.last?.1 ?? 0) + hold
    send(touch, "liftUpAtOffset:") { (fn: @convention(c) (AnyObject, Selector, Double) -> Void, selector) in fn(touch, selector, end) }
    let orientation = ((app as NSObject).value(forKey: "interfaceOrientation") as? NSNumber)?.intValue ?? 1
    let record = try make("XCSynthesizedEventRecord", "initWithName:interfaceOrientation:") { (fn: @convention(c) (AnyObject, Selector, NSString, Int) -> Unmanaged<NSObject>, object, selector) in
      fn(object, selector, "e2e drag", orientation)
    }
    record.perform(NSSelectorFromString("addPointerEventPath:"), with: touch)
    try synthesize(record, app, idleBefore: idleBefore, idleAfter: idleAfter, timeout: timeout)
  }

  /// Sends a record and waits for it to be delivered, between the app's idle waits it asks for.
  private static func synthesize(_ record: NSObject, _ app: XCUIApplication, idleBefore: Bool, idleAfter: Bool, timeout: Double) throws {
    let process = Idle.process(app)
    if idleBefore { Idle.wait(process, timeout: timeout) }
    guard let type = NSClassFromString("XCTRunnerDaemonSession") as? NSObject.Type,
      let session = type.perform(NSSelectorFromString("sharedSession"))?.takeUnretainedValue() as? NSObject
    else { throw EngineFailure.unsupported("this Xcode has no XCTest event synthesis") }
    var finished = false
    var failure: Error?
    send(session, "synthesizeEvent:completion:") { (fn: @convention(c) (AnyObject, Selector, NSObject, @escaping @convention(block) (Bool, NSError?) -> Void) -> Void, selector) in
      fn(session, selector, record) { _, error in
        failure = error
        finished = true
      }
    }
    while !finished { RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005)) }
    if let failure { throw EngineFailure.invalidState("the gesture was not delivered: \(failure.localizedDescription)") }
    if idleAfter { Idle.wait(process, timeout: timeout) }
  }


  /// A new instance of a private class: `alloc`, then `initializer` through `call`, which returns it retained.
  private static func make<F>(_ className: String, _ initializer: String, _ call: (F, AnyObject, Selector) -> Unmanaged<NSObject>) throws -> NSObject {
    let selector = NSSelectorFromString(initializer)
    guard let type = NSClassFromString(className) as? NSObject.Type, let imp = type.instanceMethod(for: selector),
      let object = type.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue()
    else { throw EngineFailure.unsupported("this Xcode has no \(className)") }
    return call(unsafeBitCast(imp, to: F.self), object, selector).takeRetainedValue()
  }

  /// Calls a private method through its implementation, typed as `F`.
  private static func send<F>(_ object: NSObject, _ name: String, _ call: (F, Selector) -> Void) {
    let selector = NSSelectorFromString(name)
    call(unsafeBitCast(object.method(for: selector), to: F.self), selector)
  }
}
