"use client";

import { type CSSProperties, useState } from "react";

const ORDER_LINES = [
  { id: "kettle", name: "Gooseneck Kettle", quantity: 1, total: 79 },
  { id: "beans", name: "Single Origin Beans 1kg", quantity: 2, total: 44 },
];

export default function CheckoutReview() {
  const [placed, setPlaced] = useState(false);

  if (placed) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Order placed successfully
        </p>
        <p style={styles.mutedText}>Order #10482 - a confirmation email is on its way.</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* PLANTED BUG (do not fix): the greeting renders a raw template token
          and the delivery estimate interpolates undefined. */}
      <p data-testid="checkout-greeting" style={styles.greeting}>
        {"Thanks, {{firstName}}! Review your order below."}
      </p>
      <ul data-testid="order-lines" style={styles.list}>
        {ORDER_LINES.map((line) => (
          <li key={line.id} style={styles.row}>
            <span>
              {line.name} x{line.quantity}
            </span>
            <span style={styles.lineTotal}>${line.total.toFixed(2)}</span>
          </li>
        ))}
      </ul>
      <div style={styles.infoBlock}>
        <p style={styles.infoRow}>
          <strong>Ship to:</strong> 221B Baker Street, London
        </p>
        <p data-testid="delivery-estimate" style={styles.infoRow}>
          <strong>Delivery:</strong> {`Arrives by ${String(undefined)}`}
        </p>
        <p style={styles.infoRow}>
          <strong>Payment:</strong> Visa ending in 4242
        </p>
      </div>
      <button
        type="button"
        data-testid="place-order-button"
        style={styles.button}
        onClick={() => setPlaced(true)}
      >
        Place order - $123.00
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
  greeting: {
    fontSize: 15,
    margin: 0,
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    padding: "10px 4px",
    borderBottom: "1px solid #e5e5e5",
    fontSize: 15,
  },
  lineTotal: {
    fontWeight: 600,
  },
  infoBlock: {
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  infoRow: {
    fontSize: 14,
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
