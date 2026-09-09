"use client";

import { type CSSProperties, useEffect, useState } from "react";

const GENERATION_MS = 1000;
const REQUIRED_CLICKS = 3;
const ROW_COUNT = 6;
const TARGET_ROW = 2;

/**
 * Stale-element gate: every GENERATION_MS the generation counter increments,
 * which remounts every row under a fresh key and rotates the row order by one
 * position. Any element handle or ref captured before a tick points at a
 * detached node, and the target's on-screen position keeps moving - the agent
 * must relocate "Tap me" before each click instead of reusing a stale handle.
 */
export default function StaleDom() {
  const [generation, setGeneration] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const done = progress >= REQUIRED_CLICKS;

  useEffect(() => {
    if (done) {
      return;
    }
    const interval: ReturnType<typeof setInterval> = setInterval(() => {
      setGeneration((previous) => previous + 1);
    }, GENERATION_MS);
    return () => clearInterval(interval);
  }, [done]);

  /**
   * Advances progress on a target click; a decoy click surfaces a recoverable
   * error and resets progress to zero.
   */
  const handleRowClick = (row: number) => {
    if (row === TARGET_ROW) {
      setError(null);
      setProgress((previous) => Math.min(previous + 1, REQUIRED_CLICKS));
      return;
    }
    setError("That was a decoy - progress reset");
    setProgress(0);
  };

  const rows = [];
  for (let position = 0; position < ROW_COUNT; position += 1) {
    const row = (position + generation) % ROW_COUNT;
    const isTarget = row === TARGET_ROW;
    rows.push(
      <div key={`gen-${generation}-row-${row}`} style={styles.row}>
        <span style={styles.rowLabel}>Slot {position + 1}</span>
        <button
          type="button"
          data-testid={isTarget ? "target-button" : "decoy-button"}
          style={styles.button}
          onClick={() => handleRowClick(row)}
        >
          {isTarget ? "Tap me" : "Decoy"}
        </button>
      </div>,
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>Click Tap me 3 times; the list rebuilds itself every second.</p>
      <p data-testid="progress" style={styles.progress}>
        Progress: {progress} / {REQUIRED_CLICKS}
      </p>
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
      {done ? (
        <p data-testid="success-message" style={styles.successText}>
          Target clicked {REQUIRED_CLICKS} times
        </p>
      ) : (
        <div style={styles.list}>{rows}</div>
      )}
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
  progress: {
    fontSize: 15,
    fontWeight: 600,
    textAlign: "center",
    margin: 0,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: 12,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "8px 12px",
    border: "1px solid #f0f0f0",
    borderRadius: 8,
  },
  rowLabel: {
    fontSize: 14,
    color: "#444",
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
    textAlign: "center",
    margin: 0,
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
