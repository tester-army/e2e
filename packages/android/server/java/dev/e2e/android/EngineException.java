package dev.e2e.android;

import org.json.JSONException;
import org.json.JSONObject;

/** A failure the protocol carries: an engine error code, or a JSON-RPC error. */
final class EngineException extends Exception {
  private final int rpcCode;
  private final String engineCode;
  private final boolean retryable;

  EngineException(int rpcCode, String message) {
    super(message);
    this.rpcCode = rpcCode;
    this.engineCode = null;
    this.retryable = false;
  }

  private EngineException(String engineCode, String message, boolean retryable) {
    super(message);
    this.rpcCode = -32000;
    this.engineCode = engineCode;
    this.retryable = retryable;
  }

  static EngineException stale(String id) {
    return new EngineException("NODE_STALE", "node " + id + " is stale; re-resolve", true);
  }

  static EngineException notActionable(String message) {
    return new EngineException("NOT_ACTIONABLE", message, false);
  }

  static EngineException unsupported(String message) {
    return new EngineException("UNSUPPORTED_CAPABILITY", message, false);
  }

  static EngineException invalidState(String message) {
    return new EngineException("INVALID_STATE", message, false);
  }

  static EngineException failure(String message) {
    return new EngineException("ENGINE_FAILURE", message, false);
  }

  static EngineException cancelled() {
    return new EngineException("CANCELLED", "operation cancelled", false);
  }

  JSONObject toJson() throws JSONException {
    JSONObject error = new JSONObject();
    error.put("code", rpcCode);
    error.put("message", getMessage());
    if (engineCode != null) {
      JSONObject data = new JSONObject();
      data.put("type", "engine");
      data.put("code", engineCode);
      data.put("retryable", retryable);
      error.put("data", data);
    }
    return error;
  }
}
