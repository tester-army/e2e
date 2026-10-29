package dev.e2e.android;

import android.net.LocalSocket;
import android.util.Log;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One protocol connection: reads framed JSON-RPC messages, answers
 * requests one at a time on a single device thread (the device has one
 * screen), and handles notifications on the reading thread as they arrive,
 * so a `$/abort` marks its signal while a request using it still runs; the
 * device checks the mark between the steps of every wait and gesture.
 */
final class Session implements Runnable {
  private final EngineInstrumentation instrumentation;
  private final Device device;
  private final JSONObject manifest;
  private final LocalSocket socket;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final Set<Integer> signals = ConcurrentHashMap.newKeySet();
  private final Set<Integer> aborted = ConcurrentHashMap.newKeySet();
  /** Signal ids first seen since the open attempt started; read only on the reading thread. */
  private Set<Integer> attemptSignals;
  private volatile boolean shutdown;
  private OutputStream output;

  Session(EngineInstrumentation instrumentation, Device device, JSONObject manifest, LocalSocket socket) {
    this.instrumentation = instrumentation;
    this.device = device;
    this.manifest = manifest;
    this.socket = socket;
  }

  @Override
  public void run() {
    try {
      InputStream input = new BufferedInputStream(socket.getInputStream());
      output = socket.getOutputStream();
      while (true) {
        String body = readMessage(input);
        if (body == null) break;
        JSONObject message;
        try {
          message = new JSONObject(body);
        } catch (JSONException malformed) {
          JSONObject error = new JSONObject();
          error.put("code", -32700);
          error.put("message", "message is not JSON");
          JSONObject response = new JSONObject();
          response.put("jsonrpc", "2.0");
          response.put("id", JSONObject.NULL);
          response.put("error", error);
          send(response);
          continue;
        }
        String method = message.opt("method") instanceof String ? message.getString("method") : null;
        if (method == null) {
          // This server sends no requests, so an id here asks for an answer it cannot get.
          if (message.has("id")) {
            JSONObject error = new JSONObject();
            error.put("code", -32600);
            error.put("message", "a request needs a string method");
            JSONObject response = new JSONObject();
            response.put("jsonrpc", "2.0");
            response.put("id", message.get("id"));
            response.put("error", error);
            send(response);
          }
          continue;
        }
        if (!message.has("id")) {
          if (notification(method, message.optJSONObject("params"))) break;
          continue;
        }
        Object id = message.get("id");
        JSONObject params = message.optJSONObject("params");
        if (method.equals("lifecycle/startAttempt")) attemptSignals = new HashSet<>();
        if (params != null) {
          int signal = Operation.of(params, aborted).signal;
          if (signals.add(signal) && attemptSignals != null) attemptSignals.add(signal);
        }
        if (method.equals("lifecycle/endAttempt") && attemptSignals != null) {
          // Every request of the attempt runs before its end on the one
          // device thread, so once that settles nothing uses these ids.
          Set<Integer> ended = attemptSignals;
          attemptSignals = null;
          worker.execute(() -> {
            answer(id, method, params == null ? new JSONObject() : params);
            signals.removeAll(ended);
            aborted.removeAll(ended);
          });
          continue;
        }
        worker.execute(() -> answer(id, method, params == null ? new JSONObject() : params));
      }
    } catch (Throwable failure) {
      Log.e(EngineInstrumentation.TAG, "session failed", failure);
    } finally {
      // A client that vanished cannot abort what it started: everything it
      // sent is abandoned, queued or running. One that shut down cleanly has
      // nothing left running.
      if (!shutdown) {
        aborted.addAll(signals);
        worker.shutdownNow();
      }
      worker.shutdown();
      // The next client gets the device only once this one's work stopped.
      try {
        while (!worker.awaitTermination(1, TimeUnit.SECONDS)) {
          Log.w(EngineInstrumentation.TAG, "waiting for the previous session's work to stop");
        }
      } catch (InterruptedException ignored) {
        Thread.currentThread().interrupt();
      }
      try {
        socket.close();
      } catch (IOException ignored) {
        // Already closed.
      }
    }
  }

  /** Handles one notification; true when the connection must end. */
  private boolean notification(String method, JSONObject params) {
    switch (method) {
      case "$/abort":
        // The abort mark stays until the attempt ends: a request the client
        // abandoned may still be queued, and it must not run.
        if (params != null) {
          aborted.add(params.optInt("id"));
          signals.remove(params.optInt("id"));
        }
        return false;
      case "exit":
        instrumentation.exit();
        return true;
      default:
        return false;
    }
  }

  private void answer(Object id, String method, JSONObject params) {
    JSONObject response = new JSONObject();
    try {
      response.put("jsonrpc", "2.0");
      response.put("id", id);
      try {
        Object result = dispatch(method, params);
        response.put("result", result == null ? JSONObject.NULL : result);
      } catch (EngineException failure) {
        response.put("error", failure.toJson());
      } catch (Throwable failure) {
        Log.e(EngineInstrumentation.TAG, method + " failed", failure);
        JSONObject error = new JSONObject();
        error.put("code", -32603);
        error.put("message", method + " failed: " + failure);
        response.put("error", error);
      }
      send(response);
    } catch (Throwable failure) {
      Log.e(EngineInstrumentation.TAG, "could not answer " + method, failure);
    }
  }

  private Object dispatch(String method, JSONObject params) throws Exception {
    switch (method) {
      case "initialize": {
        if (params.optInt("protocolVersion") != 1) {
          throw new EngineException(-32600, "this engine server speaks protocol 1");
        }
        JSONObject result = new JSONObject();
        result.put("protocolVersion", 1);
        result.put("manifest", manifest);
        return result;
      }
      case "shutdown":
        shutdown = true;
        return null;
      case "lifecycle/init":
        device.init(params.optJSONObject("app"), Operation.of(params, aborted));
        return null;
      case "lifecycle/startAttempt":
        device.startAttempt();
        notifyEnvironment(params.optString("attemptId"));
        return null;
      case "lifecycle/endAttempt":
        return null;
      case "engine/observe": {
        JSONObject options = params.optJSONObject("options");
        Operation operation = Operation.of(params, aborted);
        device.checkCancelled(operation);
        return device.observe(options != null && options.optBoolean("pixels"));
      }
      case "engine/perform":
        device.perform(params.getJSONObject("ref").getString("id"), params.getJSONObject("action"), Operation.of(params, aborted));
        return null;
      case "engine/performAt": {
        JSONObject point = params.getJSONObject("point");
        device.performAt((float) point.getDouble("x"), (float) point.getDouble("y"), params.getJSONObject("action"), Operation.of(params, aborted));
        return null;
      }
      case "keyboard/type": {
        JSONObject options = params.optJSONObject("options");
        device.type(params.getString("text"), options != null && options.optBoolean("replace"), Operation.of(params, aborted));
        return null;
      }
      case "keyboard/press":
        device.press(params.getString("key"), Operation.of(params, aborted));
        return null;
      case "keyboard/dismiss":
        device.dismissKeyboard();
        return null;
      case "session/back":
        device.back(Operation.of(params, aborted));
        return null;
      case "session/restart":
        device.restart(false, Operation.of(params, aborted));
        return null;
      case "session/reset":
        device.restart(true, Operation.of(params, aborted));
        return null;
      case "artifacts/screenshot": {
        JSONObject result = new JSONObject();
        result.put("data", device.screenshotBase64(Operation.of(params, aborted)));
        result.put("mediaType", "image/png");
        return result;
      }
      default:
        throw new EngineException(-32601, "unknown method \"" + method + "\"");
    }
  }

  private void notifyEnvironment(String attemptId) throws Exception {
    JSONObject params = new JSONObject();
    params.put("attemptId", attemptId);
    params.put("facts", device.environment());
    JSONObject message = new JSONObject();
    message.put("jsonrpc", "2.0");
    message.put("method", "attempt/environment");
    message.put("params", params);
    send(message);
  }

  private synchronized void send(JSONObject message) throws IOException {
    byte[] body = message.toString().getBytes(StandardCharsets.UTF_8);
    output.write(("Content-Length: " + body.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
    output.write(body);
    output.flush();
  }

  /** Reads one framed message body, or null at the end of the stream. */
  private static String readMessage(InputStream input) throws IOException {
    int length = -1;
    StringBuilder line = new StringBuilder();
    while (true) {
      int next = input.read();
      if (next == -1) return null;
      if (next == '\n') {
        String header = line.toString().trim();
        line.setLength(0);
        if (header.isEmpty()) {
          if (length >= 0) break;
          continue;
        }
        int colon = header.indexOf(':');
        if (colon > 0 && header.substring(0, colon).trim().equalsIgnoreCase("Content-Length")) {
          length = Integer.parseInt(header.substring(colon + 1).trim());
        }
      } else if (next != '\r') {
        line.append((char) next);
      }
    }
    byte[] body = new byte[length];
    int offset = 0;
    while (offset < length) {
      int read = input.read(body, offset, length - offset);
      if (read == -1) return null;
      offset += read;
    }
    return new String(body, StandardCharsets.UTF_8);
  }
}
