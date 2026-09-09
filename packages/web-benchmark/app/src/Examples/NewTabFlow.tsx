"use client";

import { type CSSProperties, useState } from "react";

const VERIFICATION_CODE = "TAB-88421";

const VERIFICATION_PAGE_HTML = `<!DOCTYPE html>
<html>
  <head><title>Verification</title></head>
  <body style="margin:0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:16px;background:#f6f6f6;">
    <h2 style="font-size:20px;font-weight:600;color:#111;margin:0;">Verification code</h2>
    <p style="font-family:monospace;font-size:32px;font-weight:600;color:#111;margin:0;">${VERIFICATION_CODE}</p>
    <p style="font-size:13px;color:#666;margin:0;">Return to the original tab and enter this code.</p>
  </body>
</html>`;

export default function NewTabFlow() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);

  /**
   * Opens a blank second tab and writes the verification page into it. The
   * code intentionally exists only in that second tab - the agent must
   * switch tabs, read it, and return here to enter it.
   */
  const handleOpenTab = () => {
    const win = window.open("", "_blank");
    win?.document.write(VERIFICATION_PAGE_HTML);
    win?.document.close();
  };

  /**
   * Validates the entered code against the verification code, trimming
   * whitespace and ignoring case.
   */
  const handleVerify = () => {
    if (code.trim().toUpperCase() === VERIFICATION_CODE) {
      setError(null);
      setVerified(true);
      return;
    }
    setError("Wrong verification code");
  };

  if (verified) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Verified successfully
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Open the verification tab, read the code there, come back and enter it.
      </p>
      <button
        type="button"
        data-testid="open-tab-button"
        style={styles.button}
        onClick={handleOpenTab}
      >
        Open verification tab
      </button>
      <input
        data-testid="code-input"
        style={styles.input}
        placeholder="Verification code"
        autoCapitalize="none"
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
        style={styles.button}
        onClick={handleVerify}
      >
        Verify
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
    margin: "0 0 16px",
  },
} satisfies Record<string, CSSProperties>;
