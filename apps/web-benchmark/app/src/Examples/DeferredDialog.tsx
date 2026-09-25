"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

const DIALOG_DELAY_MS = 900;

export default function DeferredDialog() {
  const [status, setStatus] = useState<"idle" | "pending" | "cancelled" | "done">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Leaving the page while a confirmation is pending must not pop it over the
  // next page.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  /**
   * Opens the confirm on a timer instead of synchronously in the click
   * handler, so the click settles before any dialog exists. A driver that
   * only checks for dialogs during the triggering action misses it; the
   * dialog must be caught when it surfaces moments later. A second click while
   * one confirmation is pending is ignored, so one interaction never queues
   * two dialogs.
   */
  const handleSubmit = () => {
    if (status === "pending") {
      return;
    }
    setStatus("pending");
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const confirmed = window.confirm("Really submit the report?");
      setStatus(confirmed ? "done" : "cancelled");
    }, DIALOG_DELAY_MS);
  };

  if (status === "done") {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Report submitted after deferred confirmation
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Submit the report; a confirmation dialog appears shortly after the click. Accept it.
      </p>
      {status === "cancelled" ? (
        <p data-testid="error-message" style={styles.errorText}>
          Submission was cancelled
        </p>
      ) : null}
      {status === "pending" ? <p style={styles.hint}>Preparing confirmation…</p> : null}
      <button
        type="button"
        data-testid="submit-report-button"
        style={styles.button}
        onClick={handleSubmit}
      >
        Submit report
      </button>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: "24px 0",
  },
  hint: {
    fontSize: 13,
    color: "#666",
    textAlign: "center",
    margin: 0,
  },
  button: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    margin: 0,
    textAlign: "center",
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
