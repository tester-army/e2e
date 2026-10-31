import Foundation
import Network
import XCTest

/// The e2e engine server for iOS, written in Swift and hosted by a UI test.
/// It speaks the e2e engine protocol (JSON-RPC 2.0 framed by Content-Length
/// headers, as LSP) on a localhost TCP port, which a simulator shares with
/// its Mac, and drives the app under test in process through XCUITest: no
/// daemon, no HTTP hop, no host process per call.
///
/// `testServe` never returns until the client sends `exit`: the test is the
/// server's lifetime. XCUITest wants the main thread, so the network runs on
/// its own queue and every request is answered on the main run loop.
final class EngineServer: XCTestCase {
  func testServe() throws {
    continueAfterFailure = true
    let environment = ProcessInfo.processInfo.environment
    let port = UInt16(environment["E2E_PORT"] ?? "") ?? 8765
    let server = try Server(port: port, device: Device())
    server.start()
    while !server.finished {
      RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    if server.failed { XCTFail("the engine server could not listen on port \(port)") }
  }
}

/// A failure the protocol carries: an engine error code, or a JSON-RPC error.
struct EngineFailure: Error {
  let rpcCode: Int
  let message: String
  let engineCode: String?
  let retryable: Bool

  static func stale(_ id: String) -> EngineFailure {
    EngineFailure(rpcCode: -32000, message: "node \(id) is stale; re-resolve", engineCode: "NODE_STALE", retryable: true)
  }

  static func notActionable(_ message: String) -> EngineFailure {
    EngineFailure(rpcCode: -32000, message: message, engineCode: "NOT_ACTIONABLE", retryable: false)
  }

  static func unsupported(_ message: String) -> EngineFailure {
    EngineFailure(rpcCode: -32000, message: message, engineCode: "UNSUPPORTED_CAPABILITY", retryable: false)
  }

  static func invalidState(_ message: String) -> EngineFailure {
    EngineFailure(rpcCode: -32000, message: message, engineCode: "INVALID_STATE", retryable: false)
  }

  static let cancelled = EngineFailure(rpcCode: -32000, message: "operation cancelled", engineCode: "CANCELLED", retryable: false)

  static func rpc(_ code: Int, _ message: String) -> EngineFailure {
    EngineFailure(rpcCode: code, message: message, engineCode: nil, retryable: false)
  }

  var json: [String: Any] {
    var error: [String: Any] = ["code": rpcCode, "message": message]
    if let engineCode {
      error["data"] = ["type": "engine", "code": engineCode, "retryable": retryable]
    }
    return error
  }
}

/// The parts of an operation context the device acts on.
struct Operation {
  let signal: Int
  let abortedWhenSent: Bool
  let timeoutMs: Double
  let aborted: AbortMarks

  init(_ params: [String: Any], aborted: AbortMarks) {
    let operation = params["operation"] as? [String: Any]
    let signal = (operation?["signal"] ?? params["signal"]) as? [String: Any]
    self.signal = signal?["id"] as? Int ?? 0
    self.abortedWhenSent = signal?["aborted"] as? Bool ?? false
    self.timeoutMs = operation?["timeoutMs"] as? Double ?? 30_000
    self.aborted = aborted
  }

  /// The operation's budget in seconds.
  var seconds: Double { timeoutMs / 1000 }

  /// Throws `CANCELLED` once the client abandoned this operation.
  func check() throws {
    if abortedWhenSent || (signal != 0 && aborted.contains(signal)) { throw EngineFailure.cancelled }
  }
}

/// The signal ids one connection aborted; ids are minted per connection.
final class AbortMarks {
  private var ids = Set<Int>()
  private let lock = NSLock()

  func add(_ id: Int) {
    lock.lock()
    ids.insert(id)
    lock.unlock()
  }

  func contains(_ id: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return ids.contains(id)
  }

  func remove(_ forgotten: Set<Int>) {
    lock.lock()
    ids.subtract(forgotten)
    lock.unlock()
  }
}

/// The listener: one connection at a time, since the device has one screen.
final class Server {
  private let listener: NWListener
  private let device: Device
  private let queue = DispatchQueue(label: "e2e.server")
  private var session: Session?
  private(set) var finished = false
  private(set) var failed = false

  init(port: UInt16, device: Device) throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
    parameters.allowLocalEndpointReuse = true
    listener = try NWListener(using: parameters)
    self.device = device
  }

  func start() {
    listener.stateUpdateHandler = { [unowned self] state in
      if case .ready = state { print("E2E_SERVER_READY") }
      if case .failed(let error) = state {
        print("E2E_SERVER_FAILED \(error)")
        DispatchQueue.main.async {
          self.failed = true
          self.finished = true
        }
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { return }
      if self.session != nil {
        connection.cancel()
        return
      }
      let session = Session(connection: connection, device: self.device, queue: self.queue) { [weak self] exit in
        self?.session = nil
        if exit {
          DispatchQueue.main.async { self?.finished = true }
        }
      }
      self.session = session
      session.start()
    }
    listener.start(queue: queue)
  }
}

/// One protocol connection: frames in, requests answered one at a time on
/// the main thread, notifications handled on arrival so `$/abort` reaches a
/// request still running.
final class Session {
  private let connection: NWConnection
  private let device: Device
  private let queue: DispatchQueue
  private let onEnd: (Bool) -> Void
  private let aborted = AbortMarks()
  private var signals = Set<Int>()
  /// Signal ids first seen during the running attempt, forgotten when it ends: the client may mint them again.
  private var attemptSignals: Set<Int>?
  private var buffer = Data()
  private var shutdown = false
  private var exitRequested = false
  private var pending: [() -> Void] = []
  private var busy = false
  private var ended = false

  init(connection: NWConnection, device: Device, queue: DispatchQueue, onEnd: @escaping (Bool) -> Void) {
    self.connection = connection
    self.device = device
    self.queue = queue
    self.onEnd = onEnd
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self?.end()
      default: break
      }
    }
    connection.start(queue: queue)
    receive()
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
      guard let self else { return }
      if let data { self.buffer.append(data) }
      self.drain()
      if complete || error != nil {
        self.end()
        return
      }
      self.receive()
    }
  }

  /// Parses every complete message in the buffer.
  private func drain() {
    let delimiter = Data("\r\n\r\n".utf8)
    while let range = buffer.range(of: delimiter) {
      let header = String(decoding: buffer[buffer.startIndex..<range.lowerBound], as: UTF8.self)
      guard let length = header.split(separator: "\r\n").compactMap({ line -> Int? in
        let parts = line.split(separator: ":", maxSplits: 1)
        guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" else { return nil }
        return Int(parts[1].trimmingCharacters(in: .whitespaces))
      }).first, length >= 0 else {
        connection.cancel()
        return
      }
      let bodyStart = range.upperBound
      guard buffer.distance(from: bodyStart, to: buffer.endIndex) >= length else { return }
      let bodyEnd = buffer.index(bodyStart, offsetBy: length)
      let body = buffer[bodyStart..<bodyEnd]
      buffer = Data(buffer[bodyEnd...])
      guard let message = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
        send(["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32700, "message": "message is not JSON"]])
        continue
      }
      handle(message)
    }
  }

  private func handle(_ message: [String: Any]) {
    let id = message["id"].flatMap { $0 is NSNull ? nil : $0 }
    guard let method = message["method"] as? String else {
      // This server sends no requests, so an id here asks for an answer it cannot get.
      if let id { send(["jsonrpc": "2.0", "id": id, "error": ["code": -32600, "message": "a request needs a string method"]]) }
      return
    }
    let params = message["params"] as? [String: Any] ?? [:]
    guard let id else {
      notification(method, params)
      return
    }
    let operation = Operation(params, aborted: aborted)
    if method == "lifecycle/startAttempt" { attemptSignals = [] }
    if signals.insert(operation.signal).inserted { attemptSignals?.insert(operation.signal) }
    enqueue { [weak self] in
      guard let self else { return }
      var response: [String: Any] = ["jsonrpc": "2.0", "id": id]
      do {
        response["result"] = try self.dispatch(method, params, operation) ?? NSNull()
      } catch let failure as EngineFailure {
        response["error"] = failure.json
      } catch {
        response["error"] = ["code": -32603, "message": "\(method) failed: \(error)"]
      }
      self.queue.async { self.send(response) }
    }
  }

  /// Runs `work` on the main thread after every request before it.
  private func enqueue(_ work: @escaping () -> Void) {
    pending.append(work)
    pump()
  }

  private func pump() {
    guard !busy, !pending.isEmpty else { return }
    busy = true
    let work = pending.removeFirst()
    DispatchQueue.main.async { [weak self] in
      work()
      self?.queue.async {
        self?.busy = false
        self?.pump()
      }
    }
  }

  private func notification(_ method: String, _ params: [String: Any]) {
    switch method {
    case "$/abort":
      if let id = params["id"] as? Int { aborted.add(id) }
    case "exit":
      exitRequested = true
      connection.cancel()
    default:
      break
    }
  }

  private func dispatch(_ method: String, _ params: [String: Any], _ operation: Operation) throws -> Any? {
    switch method {
    case "initialize":
      guard params["protocolVersion"] as? Int == 1 else { throw EngineFailure.rpc(-32600, "this engine server speaks protocol 1") }
      return ["protocolVersion": 1, "manifest": Manifest.json]
    case "shutdown":
      queue.async { self.shutdown = true }
      return nil
    case "lifecycle/init":
      try device.initialize(app: params["app"] as? [String: Any], operation)
      return nil
    case "lifecycle/startAttempt":
      device.startAttempt()
      let attemptId = params["attemptId"] as? String ?? ""
      let facts = device.environment()
      queue.async {
        self.send(["jsonrpc": "2.0", "method": "attempt/environment", "params": ["attemptId": attemptId, "facts": facts]])
      }
      return nil
    case "lifecycle/endAttempt":
      queue.async { self.forgetAttemptSignals() }
      return nil
    case "engine/observe":
      try operation.check()
      let options = params["options"] as? [String: Any]
      return try device.observe(pixels: options?["pixels"] as? Bool ?? false)
    case "engine/perform":
      let ref = params["ref"] as? [String: Any] ?? [:]
      try device.perform(ref["id"] as? String ?? "", params["action"] as? [String: Any] ?? [:], operation)
      return nil
    case "engine/performAt":
      let point = params["point"] as? [String: Any] ?? [:]
      try device.performAt(CGPoint(x: point["x"] as? Double ?? 0, y: point["y"] as? Double ?? 0), params["action"] as? [String: Any] ?? [:], operation)
      return nil
    case "keyboard/type":
      let options = params["options"] as? [String: Any]
      try device.type(params["text"] as? String ?? "", replace: options?["replace"] as? Bool ?? false, operation)
      return nil
    case "keyboard/press":
      try device.press(params["key"] as? String ?? "", operation)
      return nil
    case "session/back":
      try device.back(operation)
      return nil
    case "artifacts/screenshot":
      try operation.check()
      return ["data": try device.screenshotBase64(), "mediaType": "image/png"]
    default:
      throw EngineFailure.rpc(-32601, "unknown method \"\(method)\"")
    }
  }

  /// Forgets every signal id first seen during the attempt that ended.
  private func forgetAttemptSignals() {
    guard let ids = attemptSignals else { return }
    attemptSignals = nil
    signals.subtract(ids)
    aborted.remove(ids)
  }

  private func send(_ message: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: message) else { return }
    var frame = Data("Content-Length: \(body.count)\r\n\r\n".utf8)
    frame.append(body)
    connection.send(content: frame, completion: .contentProcessed { _ in })
  }

  /// A client that vanished without `shutdown` abandons everything it sent.
  private func end() {
    guard !ended else { return }
    ended = true
    if !shutdown {
      for signal in signals { aborted.add(signal) }
      pending.removeAll()
    }
    let exit = exitRequested
    connection.stateUpdateHandler = nil
    onEnd(exit)
  }
}
