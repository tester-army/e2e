"use client";

import { type CSSProperties, type UIEvent, useState } from "react";

const TOTAL_ROWS = 5000;
const ROW_HEIGHT = 36;
const VIEWPORT_HEIGHT = 480;
const OVERSCAN = 5;
const TARGET_ROW = 4321;

/**
 * Windowed table gate: only rows inside the visible range (plus OVERSCAN) are
 * mounted in the DOM. Off-screen rows do not exist as elements, so the agent
 * cannot find the Golden Row by querying the DOM - it must actually scroll
 * the viewport until row index 4321 enters the rendered window.
 */
export default function VirtualizedTable() {
  const [scrollTop, setScrollTop] = useState(0);
  const [claimed, setClaimed] = useState(false);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    TOTAL_ROWS,
    Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN,
  );

  const rows = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const isTarget = index === TARGET_ROW;
    rows.push(
      <div key={index} data-testid="table-row" style={{ ...styles.row, top: index * ROW_HEIGHT }}>
        <span style={isTarget ? styles.targetLabel : styles.rowLabel}>
          {isTarget ? `Row ${TARGET_ROW + 1} — Golden Row` : `Row ${index + 1}`}
        </span>
        {isTarget ? (
          <button
            type="button"
            data-testid="claim-button"
            style={styles.button}
            onClick={() => setClaimed(true)}
          >
            Claim
          </button>
        ) : null}
      </div>,
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        The Golden Row is deep in the table; off-screen rows are not in the DOM.
      </p>
      {claimed ? (
        <p data-testid="success-message" style={styles.successText}>
          Golden Row claimed
        </p>
      ) : null}
      <div data-testid="table-viewport" style={styles.viewport} onScroll={handleScroll}>
        <div style={styles.spacer}>{rows}</div>
      </div>
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
  viewport: {
    height: VIEWPORT_HEIGHT,
    overflow: "auto",
    border: "1px solid #e5e5e5",
    borderRadius: 8,
  },
  spacer: {
    height: TOTAL_ROWS * ROW_HEIGHT,
    position: "relative",
  },
  row: {
    position: "absolute",
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "0 16px",
    borderBottom: "1px solid #f0f0f0",
    boxSizing: "border-box",
  },
  rowLabel: {
    fontSize: 14,
  },
  targetLabel: {
    fontSize: 14,
    fontWeight: 600,
  },
  button: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "4px 12px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
