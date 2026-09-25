"use client";

import { type CSSProperties, useState } from "react";

const SECRET_CODE = "7291";
const PAD_TILES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "‹", "0", "→"];

/**
 * ADVERSARIAL: a PIN pad built entirely from bare divs. There are no
 * semantic elements, no buttons, no inputs, no aria attributes, no roles,
 * no tabIndex, and no test ids - even the cursor stays "default" over the
 * tappable tiles. The DOM hierarchy is useless for locating controls; the
 * agent must rely on vision and click coordinates to read the on-screen
 * instructions, tap the digit tiles, and press the arrow to submit.
 */
export default function DivSoup() {
  const [entered, setEntered] = useState("");
  const [wrong, setWrong] = useState(false);
  const [granted, setGranted] = useState(false);

  /**
   * Routes a tile tap: digits append up to the code length, "‹" deletes the
   * last digit, and "→" validates the entered code against the secret.
   */
  const handleTile = (tile: string) => {
    if (granted) {
      return;
    }
    if (tile === "‹") {
      setEntered((current) => current.slice(0, -1));
      setWrong(false);
      return;
    }
    if (tile === "→") {
      if (entered === SECRET_CODE) {
        setWrong(false);
        setGranted(true);
        return;
      }
      setEntered("");
      setWrong(true);
      return;
    }
    setWrong(false);
    setEntered((current) => (current.length >= SECRET_CODE.length ? current : current + tile));
  };

  if (granted) {
    return (
      <div style={styles.container}>
        <div style={styles.successText}>Access granted</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.hint}>Enter the code {SECRET_CODE} and press the arrow</div>
      <div style={styles.dotsRow}>
        {Array.from({ length: SECRET_CODE.length }, (_, index) => (
          <div key={index} style={index < entered.length ? styles.dotFilled : styles.dot} />
        ))}
      </div>
      {wrong ? <div style={styles.errorText}>Wrong code</div> : null}
      <div style={styles.grid}>
        {PAD_TILES.map((tile) => (
          <div key={tile} style={styles.tile} onClick={() => handleTile(tile)}>
            {tile}
          </div>
        ))}
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
    alignItems: "center",
  },
  hint: {
    fontSize: 13,
    color: "#666",
    textAlign: "center",
  },
  dotsRow: {
    display: "flex",
    gap: 12,
    justifyContent: "center",
    padding: "8px 0",
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    border: "1px solid #ccc",
    backgroundColor: "#fff",
  },
  dotFilled: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    border: "1px solid #111",
    backgroundColor: "#111",
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    textAlign: "center",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 72px)",
    gap: 12,
  },
  tile: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 56,
    backgroundColor: "#111",
    color: "#fff",
    fontSize: 16,
    fontWeight: 600,
    borderRadius: 8,
    cursor: "default",
    userSelect: "none",
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
  },
} satisfies Record<string, CSSProperties>;
