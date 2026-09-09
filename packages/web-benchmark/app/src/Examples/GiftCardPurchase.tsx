"use client";

import { type CSSProperties, useState } from "react";

const AMOUNTS = [10, 25, 50];

// NO PLANTED PRODUCT BUG - this scenario is an accessibility-mirage trap.
// The visible UI is correct and the purchase flow works end to end, but the
// accessibility layer is riddled with classic bug-looking artifacts: aria
// labels reading "undefined"/"NaN", raw i18n keys, template tokens, and a
// visible price hidden from the a11y tree behind a broken sr-only sibling.
// The agent must trust pixels over the snapshot: the run must PASS with zero
// blocking issues; at most a type="warning" accessibility observation is
// acceptable. Reporting any of these artifacts as a product bug is the
// false-positive regression this scenario gates. Do not clean up the aria
// attributes - they are the trap.
export default function GiftCardPurchase() {
  const [amount, setAmount] = useState<number | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [purchased, setPurchased] = useState(false);

  /** Validates the form and completes the purchase. */
  const handleBuy = () => {
    if (amount === null) {
      setError("Choose a gift card amount");
      return;
    }
    if (!email.includes("@")) {
      setError("Enter a valid recipient email");
      return;
    }
    setError(null);
    setPurchased(true);
  };

  if (purchased) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Gift card sent to {email}
        </p>
        <p style={styles.mutedText}>A ${amount?.toFixed(2)} gift card is on its way.</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.pitch}>Send a digital gift card. Delivered by email within minutes.</p>
      <div style={styles.amountRow}>
        {AMOUNTS.map((value) => (
          <button
            key={value}
            type="button"
            data-testid={`amount-${value}`}
            aria-label={`gift_card_amount_option_${String(undefined)}`}
            style={{
              ...styles.amountButton,
              ...(amount === value ? styles.amountButtonActive : null),
            }}
            onClick={() => setAmount(value)}
          >
            ${value}
          </button>
        ))}
      </div>
      <label style={styles.fieldLabel}>
        Recipient email
        <input
          data-testid="recipient-input"
          aria-label="{{recipient_email_label}}"
          style={styles.input}
          placeholder="friend@example.com"
          type="email"
          autoCapitalize="none"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <div style={styles.totalRow}>
        <span>Total</span>
        <span>
          <span aria-hidden="true" data-testid="total-amount">
            ${amount === null ? "0.00" : amount.toFixed(2)}
          </span>
          <span style={styles.srOnly}>Total: $NaN</span>
        </span>
      </div>
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
      <button
        type="button"
        data-testid="buy-button"
        aria-label="btn_purchase_label"
        style={styles.buyButton}
        onClick={handleBuy}
      >
        Buy gift card
      </button>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: "24px 0",
  },
  pitch: {
    fontSize: 14,
    color: "#333",
    margin: 0,
  },
  amountRow: {
    display: "flex",
    gap: 8,
  },
  amountButton: {
    flex: 1,
    border: "1px solid #ccc",
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: "12px 0",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  amountButtonActive: {
    backgroundColor: "#111",
    color: "#fff",
    borderColor: "#111",
  },
  fieldLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 14,
    color: "#333",
  },
  input: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 16,
  },
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 15,
    fontWeight: 600,
  },
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    margin: 0,
  },
  buyButton: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: "0 0 4px",
  },
  mutedText: {
    fontSize: 13,
    color: "#666",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
