"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

const INITIAL_LOAD_MS = 2000;
const TOAST_MS = 2500;
const CODE = "4407";

/**
 * Async-states gate: the screen starts as a skeleton for INITIAL_LOAD_MS, the
 * verification code only exists inside a toast that auto-dismisses after
 * TOAST_MS, and the Verify button stays disabled until a code was sent. The
 * agent must wait out loading, catch the transient toast, and submit in time.
 */
export default function AsyncStates() {
  const [loading, setLoading] = useState(true);
  const [toastVisible, setToastVisible] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const loadTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      setLoading(false);
    }, INITIAL_LOAD_MS);
    return () => {
      clearTimeout(loadTimer);
      if (toastTimerRef.current !== null) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  /**
   * Shows the code toast and schedules its auto-dismiss, replacing any timer
   * from a previous send so resends restart the TOAST_MS window.
   */
  const handleSendCode = () => {
    setCodeSent(true);
    setToastVisible(true);
    if (toastTimerRef.current !== null) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setToastVisible(false);
    }, TOAST_MS);
  };

  const handleVerify = () => {
    if (code.trim() !== CODE) {
      setError("Wrong code - send it again and retry");
      return;
    }
    setError(null);
    setVerified(true);
  };

  if (loading) {
    return (
      <div data-testid="initial-loading" style={styles.container}>
        <div style={styles.skeleton} />
        <div style={styles.skeleton} />
        <div style={styles.skeleton} />
      </div>
    );
  }

  if (verified) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Code verified successfully
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Send the code, read it from the toast before it disappears, then verify.
      </p>
      <button
        type="button"
        data-testid="send-code-button"
        style={styles.button}
        onClick={handleSendCode}
      >
        Send code
      </button>
      <input
        data-testid="code-input"
        style={styles.input}
        placeholder="Verification code"
        inputMode="numeric"
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
      <button
        type="button"
        data-testid="verify-button"
        style={codeSent ? styles.button : styles.buttonDisabled}
        disabled={!codeSent}
        onClick={handleVerify}
      >
        Verify
      </button>
      {toastVisible ? (
        <div data-testid="toast" style={styles.toast}>
          Your code is {CODE}
        </div>
      ) : null}
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
  skeleton: {
    height: 48,
    backgroundColor: "#e5e5e5",
    borderRadius: 8,
  },
  input: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 16,
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
  buttonDisabled: {
    backgroundColor: "#999",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "not-allowed",
  },
  toast: {
    position: "fixed",
    bottom: 24,
    left: "50%",
    transform: "translateX(-50%)",
    backgroundColor: "#111",
    color: "#fff",
    borderRadius: 8,
    padding: "12px 20px",
    fontSize: 15,
    fontWeight: 600,
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    margin: 0,
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
