"use client";

import { type CSSProperties, useState } from "react";

const STYLE_SHEET = `
.wb-css-instruction::before { content: "Press Ship it, then confirm"; }
.wb-css-action-a::before { content: "Archive"; }
.wb-css-action-b::before { content: "Ship it"; }
.wb-css-action-c::before { content: "Delete"; }
.wb-css-confirm::before { content: "Confirm ship"; }
.wb-css-error::before { content: "Wrong action"; }
.wb-css-success::before { content: "Shipped successfully"; }
`;

/**
 * Deliberately hostile accessibility: every visible string on this screen is
 * injected through CSS `::before content`, so the DOM contains nothing but
 * empty divs with meaningless class names. Text extraction, innerText, and
 * a11y snapshots all come back blank; the rendered pixels are the only place
 * the labels exist. The agent must read the screen visually and click the
 * right empty tiles.
 */
export default function CssContentUi() {
  const [step, setStep] = useState<"pick" | "confirm" | "done">("pick");
  const [failed, setFailed] = useState(false);

  /**
   * Only the tile whose CSS-rendered label reads "Ship it" advances the flow;
   * the other tiles flash the CSS-rendered error and keep the picker open.
   */
  const handleAction = (correct: boolean) => {
    if (!correct) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setStep("confirm");
  };

  return (
    <div style={styles.container}>
      <style>{STYLE_SHEET}</style>
      {step === "pick" ? (
        <>
          <div className="wb-css-instruction" style={styles.instruction} />
          <div style={styles.tileRow}>
            <div
              className="wb-css-action-a"
              style={styles.tile}
              onClick={() => handleAction(false)}
            />
            <div
              className="wb-css-action-b"
              style={styles.tile}
              onClick={() => handleAction(true)}
            />
            <div
              className="wb-css-action-c"
              style={styles.tile}
              onClick={() => handleAction(false)}
            />
          </div>
          {failed ? <div className="wb-css-error" style={styles.errorText} /> : null}
        </>
      ) : null}
      {step === "confirm" ? (
        <div
          className="wb-css-confirm"
          style={styles.confirmButton}
          onClick={() => setStep("done")}
        />
      ) : null}
      {step === "done" ? <div className="wb-css-success" style={styles.successText} /> : null}
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: "24px 0",
    alignItems: "center",
  },
  instruction: {
    fontSize: 13,
    color: "#666",
  },
  tileRow: {
    display: "flex",
    gap: 12,
  },
  tile: {
    minWidth: 110,
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "14px 16px",
    fontSize: 16,
    fontWeight: 600,
    textAlign: "center",
    cursor: "default",
    userSelect: "none",
  },
  confirmButton: {
    backgroundColor: "#111",
    color: "#fff",
    borderRadius: 8,
    padding: "12px 24px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "default",
    userSelect: "none",
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
  },
} satisfies Record<string, CSSProperties>;
