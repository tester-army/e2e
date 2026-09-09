"use client";

import { type CSSProperties, useState } from "react";

const GIFT_CODE = "GIFT-7";

export default function NativeDialogs() {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /**
   * Runs the order through a chain of native browser dialogs - confirm,
   * prompt, then alert. These dialogs live outside the DOM entirely, so
   * DOM-only agents see nothing; the driver must answer them at the browser
   * level for the flow to proceed.
   */
  const handlePlaceOrder = () => {
    const confirmed = window.confirm("Place this order?");
    if (!confirmed) {
      setError("Order was cancelled");
      return;
    }
    const code = window.prompt("Enter your gift code");
    if (code === null || code.trim() !== GIFT_CODE) {
      setError("Invalid gift code");
      return;
    }
    window.alert("Order placed. Thank you!");
    setError(null);
    setDone(true);
  };

  if (done) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Order placed with code {GIFT_CODE}
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Place the order, confirm the dialog, enter gift code {GIFT_CODE} when prompted.
      </p>
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
      <button
        type="button"
        data-testid="place-order-button"
        style={styles.button}
        onClick={handlePlaceOrder}
      >
        Place order
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
