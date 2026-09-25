"use client";

import { type CSSProperties, useState } from "react";

type LineItem = {
  id: string;
  name: string;
  unitPrice: number;
};

const LINE_ITEMS: LineItem[] = [
  { id: "tee", name: "Organic Cotton Tee", unitPrice: 20 },
  { id: "cap", name: "Corduroy Cap", unitPrice: 29 },
];

const SHIPPING = 5;

const INITIAL_QUANTITIES: Record<string, number> = { tee: 1, cap: 1 };

/** Sums line totals for the given quantities. */
const computeSubtotal = (quantities: Record<string, number>): number =>
  LINE_ITEMS.reduce((sum, item) => sum + item.unitPrice * (quantities[item.id] ?? 0), 0);

export default function CartTotals() {
  const [quantities, setQuantities] = useState<Record<string, number>>(INITIAL_QUANTITIES);
  // PLANTED BUG (do not fix): the order summary is computed once from the
  // initial quantities and never recalculated, so quantity changes update the
  // line totals but leave the summary stale.
  const [summarySubtotal] = useState(() => computeSubtotal(INITIAL_QUANTITIES));

  /** Adjusts a line item quantity, clamped to the 1-9 range. */
  const adjustQuantity = (itemId: string, delta: number) => {
    setQuantities((current) => ({
      ...current,
      [itemId]: Math.min(9, Math.max(1, (current[itemId] ?? 1) + delta)),
    }));
  };

  return (
    <div style={styles.container}>
      <ul data-testid="cart-lines" style={styles.list}>
        {LINE_ITEMS.map((item) => {
          const quantity = quantities[item.id] ?? 1;
          return (
            <li key={item.id} style={styles.row}>
              <span style={styles.itemName}>{item.name}</span>
              <span style={styles.stepper}>
                <button
                  type="button"
                  data-testid={`decrease-${item.id}`}
                  style={styles.stepButton}
                  onClick={() => adjustQuantity(item.id, -1)}
                >
                  -
                </button>
                <span data-testid={`quantity-${item.id}`} style={styles.quantity}>
                  {quantity}
                </span>
                <button
                  type="button"
                  data-testid={`increase-${item.id}`}
                  style={styles.stepButton}
                  onClick={() => adjustQuantity(item.id, 1)}
                >
                  +
                </button>
              </span>
              <span data-testid={`line-total-${item.id}`} style={styles.lineTotal}>
                ${(item.unitPrice * quantity).toFixed(2)}
              </span>
            </li>
          );
        })}
      </ul>
      <div data-testid="order-summary" style={styles.summary}>
        <div style={styles.summaryRow}>
          <span>Subtotal</span>
          <span data-testid="summary-subtotal">${summarySubtotal.toFixed(2)}</span>
        </div>
        <div style={styles.summaryRow}>
          <span>Shipping</span>
          <span data-testid="summary-shipping">${SHIPPING.toFixed(2)}</span>
        </div>
        <div style={{ ...styles.summaryRow, ...styles.summaryTotalRow }}>
          <span>Order total</span>
          <span data-testid="summary-total">${(summarySubtotal + SHIPPING).toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
    padding: "24px 0",
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
    alignItems: "center",
    gap: 12,
    padding: "12px 4px",
    borderBottom: "1px solid #e5e5e5",
    fontSize: 15,
  },
  itemName: {
    flex: 1,
  },
  stepper: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  stepButton: {
    width: 28,
    height: 28,
    border: "1px solid #ccc",
    borderRadius: 6,
    backgroundColor: "#fff",
    fontSize: 16,
    cursor: "pointer",
  },
  quantity: {
    minWidth: 16,
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
  },
  lineTotal: {
    minWidth: 72,
    textAlign: "right",
    fontWeight: 600,
  },
  summary: {
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    fontSize: 14,
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
  },
  summaryTotalRow: {
    borderTop: "1px solid #e5e5e5",
    paddingTop: 8,
    fontWeight: 700,
    fontSize: 15,
  },
} satisfies Record<string, CSSProperties>;
