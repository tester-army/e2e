package dev.e2e.android;

import java.util.Set;
import org.json.JSONObject;

/** The parts of an operation context the device acts on: its signal, budget, and origin. */
final class Operation {
  final int signal;
  final long timeoutMs;
  final boolean agent;
  private final boolean abortedWhenSent;
  private final Set<Integer> aborted;

  private Operation(int signal, boolean abortedWhenSent, long timeoutMs, boolean agent, Set<Integer> aborted) {
    this.signal = signal;
    this.abortedWhenSent = abortedWhenSent;
    this.timeoutMs = timeoutMs;
    this.agent = agent;
    this.aborted = aborted;
  }

  /**
   * The request's `operation`, or for a lifecycle hook its bare `signal`
   * with the default budget. `aborted` is the session's set of aborted
   * signal ids: ids are minted per connection, so they mean nothing beyond it.
   */
  static Operation of(JSONObject params, Set<Integer> aborted) {
    JSONObject operation = params.optJSONObject("operation");
    JSONObject signal = operation == null ? params.optJSONObject("signal") : operation.optJSONObject("signal");
    return new Operation(
        signal == null ? 0 : signal.optInt("id"),
        signal != null && signal.optBoolean("aborted"),
        operation == null ? 30_000 : operation.optLong("timeoutMs", 30_000),
        operation != null && "agent".equals(operation.optString("origin")),
        aborted);
  }

  /** Whether the client abandoned this operation. */
  boolean cancelled() {
    return abortedWhenSent || (signal != 0 && aborted.contains(signal));
  }
}
