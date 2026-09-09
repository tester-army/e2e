"use client";

import { type CSSProperties, useState } from "react";

const FILLER_BLOCKS = 14;
const FILLER_BLOCK_HEIGHT = 200;
const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 96;

/**
 * Sticky chrome gate: an opaque sticky footer overlaps the bottom 96px of the
 * scroll viewport and sits above the content in z-order, so it intercepts
 * pointer events for anything underneath it. The Accept terms button lives
 * near the bottom of ~2800px of filler; the agent must scroll far enough that
 * the button clears the footer before a click can land on it.
 */
export default function StickyChrome() {
  const [accepted, setAccepted] = useState(false);

  const fillerBlocks = [];
  for (let i = 0; i < FILLER_BLOCKS; i += 1) {
    fillerBlocks.push(
      <div key={i} style={styles.fillerBlock}>
        <p style={styles.fillerTitle}>Section {i + 1}</p>
        <p style={styles.fillerText}>
          These terms describe how the benchmark service is provided. Section {i + 1} repeats the
          same deterministic paragraph so the page is tall enough that the accept button sits far
          below the fold, behind the sticky promo footer.
        </p>
      </div>,
    );
  }

  return (
    <div style={styles.container}>
      {accepted ? (
        <p data-testid="success-message" style={styles.successText}>
          Terms accepted
        </p>
      ) : null}
      <p style={styles.hint}>
        Scroll to the Accept terms button near the bottom and click it once it is clear of the
        sticky footer.
      </p>
      <div data-testid="scroll-container" style={styles.scroller}>
        <div data-testid="sticky-header" style={styles.header}>
          Terms of Service
        </div>
        {fillerBlocks}
        <div style={styles.acceptRow}>
          <button
            type="button"
            data-testid="accept-button"
            style={styles.button}
            onClick={() => setAccepted(true)}
          >
            Accept terms
          </button>
        </div>
        <div data-testid="sticky-footer" style={styles.footer}>
          Sticky promo footer — always on top
        </div>
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
  scroller: {
    position: "relative",
    height: 480,
    overflow: "auto",
    border: "1px solid #e5e5e5",
    borderRadius: 8,
  },
  header: {
    position: "sticky",
    top: 0,
    height: HEADER_HEIGHT,
    display: "flex",
    alignItems: "center",
    padding: "0 16px",
    backgroundColor: "#fff",
    borderBottom: "1px solid #e5e5e5",
    fontSize: 16,
    fontWeight: 600,
    zIndex: 2,
    boxSizing: "border-box",
  },
  footer: {
    position: "sticky",
    bottom: 0,
    height: FOOTER_HEIGHT,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 16px",
    backgroundColor: "#fff",
    borderTop: "1px solid #e5e5e5",
    fontSize: 14,
    fontWeight: 600,
    zIndex: 2,
    boxSizing: "border-box",
  },
  fillerBlock: {
    height: FILLER_BLOCK_HEIGHT,
    padding: "16px",
    boxSizing: "border-box",
  },
  fillerTitle: {
    fontSize: 15,
    fontWeight: 600,
    margin: "0 0 8px",
  },
  fillerText: {
    fontSize: 14,
    color: "#444",
    lineHeight: 1.5,
    margin: 0,
  },
  acceptRow: {
    display: "flex",
    justifyContent: "center",
    padding: "16px",
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
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
