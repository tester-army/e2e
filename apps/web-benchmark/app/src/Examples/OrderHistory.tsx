"use client";

import { type CSSProperties, useState } from "react";

type Tab = "overview" | "orders" | "settings";

const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  orders: "Orders",
  settings: "Settings",
};

export default function OrderHistory() {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div style={styles.container}>
      <nav style={styles.tabBar}>
        {(["overview", "orders", "settings"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            data-testid={`tab-${entry}`}
            style={{ ...styles.tabButton, ...(tab === entry ? styles.tabButtonActive : null) }}
            onClick={() => setTab(entry)}
          >
            {TAB_LABELS[entry]}
          </button>
        ))}
      </nav>
      {tab === "overview" ? (
        <div data-testid="overview-panel" style={styles.panel}>
          <p style={styles.panelTitle}>Welcome back, Alex</p>
          <p style={styles.panelText}>You have 3 orders and 1 active subscription.</p>
        </div>
      ) : null}
      {tab === "orders" ? (
        /* PLANTED BUG (do not fix): the orders panel is stuck loading forever.
           The skeleton never resolves even though the rest of the account
           area works, so order history is unreachable. */
        <div data-testid="orders-panel" style={styles.panel}>
          <p style={styles.panelText}>Loading your orders...</p>
          <div style={styles.skeleton} />
          <div style={styles.skeleton} />
          <div style={styles.skeleton} />
        </div>
      ) : null}
      {tab === "settings" ? (
        <div data-testid="settings-panel" style={styles.panel}>
          <p style={styles.panelTitle}>Settings</p>
          <p style={styles.panelText}>Email: alex@example.com</p>
          <p style={styles.panelText}>Plan: Pro (renews monthly)</p>
        </div>
      ) : null}
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
  panel: {
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  panelTitle: {
    fontSize: 16,
    fontWeight: 600,
    margin: 0,
  },
  panelText: {
    fontSize: 14,
    color: "#333",
    margin: 0,
  },
  skeleton: {
    height: 16,
    borderRadius: 4,
    backgroundColor: "#eee",
  },
} satisfies Record<string, CSSProperties>;
