"use client";

import { type CSSProperties, useState } from "react";

type Product = {
  id: string;
  name: string;
  price: number;
};

const PRODUCTS: Product[] = [
  { id: "planner", name: "Weekly Desk Planner", price: 24 },
  { id: "pen", name: "Brass Fountain Pen", price: 58 },
  { id: "notebook", name: "Dot Grid Notebook", price: 14 },
];

export default function Wishlist() {
  const [tab, setTab] = useState<"shop" | "wishlist">("shop");
  const [savedIds, setSavedIds] = useState<string[]>([]);

  /** Toggles whether a product is saved to the wishlist. */
  const toggleSaved = (productId: string) => {
    setSavedIds((current) =>
      current.includes(productId)
        ? current.filter((id) => id !== productId)
        : [...current, productId],
    );
  };

  return (
    <div style={styles.container}>
      <nav style={styles.tabBar}>
        <button
          type="button"
          data-testid="tab-shop"
          style={{ ...styles.tabButton, ...(tab === "shop" ? styles.tabButtonActive : null) }}
          onClick={() => setTab("shop")}
        >
          Shop
        </button>
        <button
          type="button"
          data-testid="tab-wishlist"
          style={{ ...styles.tabButton, ...(tab === "wishlist" ? styles.tabButtonActive : null) }}
          onClick={() => setTab("wishlist")}
        >
          Wishlist ({savedIds.length})
        </button>
      </nav>
      {tab === "shop" ? (
        <ul data-testid="shop-list" style={styles.list}>
          {PRODUCTS.map((product) => {
            const saved = savedIds.includes(product.id);
            return (
              <li key={product.id} style={styles.row}>
                <span>
                  {product.name} <span style={styles.price}>${product.price.toFixed(2)}</span>
                </span>
                <button
                  type="button"
                  data-testid={`save-${product.id}`}
                  style={{ ...styles.saveButton, ...(saved ? styles.saveButtonActive : null) }}
                  onClick={() => toggleSaved(product.id)}
                >
                  {saved ? "♥ Saved" : "♡ Save"}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        /* PLANTED BUG (do not fix): the wishlist tab ignores the saved items.
           The tab badge counts saves correctly, but the list always renders
           the empty state, so saved products are gone when the user looks. */
        <div data-testid="wishlist-panel" style={styles.emptyState}>
          <p data-testid="wishlist-empty" style={styles.emptyText}>
            No saved items yet.
          </p>
          <p style={styles.emptyHint}>Tap Save on any product to keep it here.</p>
        </div>
      )}
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
  tabBar: {
    display: "flex",
    gap: 8,
  },
  tabButton: {
    border: "1px solid #ccc",
    backgroundColor: "#fff",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 14,
    cursor: "pointer",
  },
  tabButtonActive: {
    backgroundColor: "#111",
    color: "#fff",
    borderColor: "#111",
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
    alignItems: "center",
    padding: "12px 4px",
    borderBottom: "1px solid #e5e5e5",
    fontSize: 15,
  },
  price: {
    color: "#666",
    fontSize: 13,
    marginLeft: 6,
  },
  saveButton: {
    border: "1px solid #ccc",
    backgroundColor: "#fff",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
  },
  saveButtonActive: {
    borderColor: "#c00",
    color: "#c00",
  },
  emptyState: {
    border: "1px dashed #ccc",
    borderRadius: 8,
    padding: 24,
    textAlign: "center",
  },
  emptyText: {
    fontSize: 15,
    fontWeight: 600,
    margin: "0 0 4px",
  },
  emptyHint: {
    fontSize: 13,
    color: "#666",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
