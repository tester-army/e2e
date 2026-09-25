"use client";

import { type CSSProperties, type DragEvent, useState } from "react";

const REQUIRED_ORDER = ["Banana", "Cherry"];

const ITEMS = ["Apple", "Banana", "Cherry"];

/**
 * Sabotage scenario: the gate is real HTML5 dataTransfer-based drag and drop.
 * Plain clicks do nothing - the agent must fire genuine dragstart, dragover,
 * and drop events so dataTransfer carries the item name into the dropzone.
 * Items must land in REQUIRED_ORDER exactly; Apple or any out-of-order drop
 * resets the dropzone.
 */
export default function DragAndDrop() {
  const [dropped, setDropped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleDragStart = (event: DragEvent<HTMLDivElement>, name: string) => {
    event.dataTransfer.setData("text/plain", name);
    event.dataTransfer.effectAllowed = "move";
  };

  /**
   * Reads the dragged item name from dataTransfer and enforces the required
   * drop sequence, resetting the dropzone on any wrong or out-of-order item.
   */
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const name = event.dataTransfer.getData("text/plain");
    if (!name || done) {
      return;
    }
    const expected = REQUIRED_ORDER[dropped.length];
    if (name !== expected) {
      setDropped([]);
      setError("Wrong item order, starting over");
      return;
    }
    const next = [...dropped, name];
    setError(null);
    setDropped(next);
    if (next.length === REQUIRED_ORDER.length) {
      setDone(true);
    }
  };

  return (
    <div style={styles.container}>
      <p style={styles.hint}>Drag Banana into the dropzone, then Cherry. Leave Apple alone.</p>
      <div style={styles.itemsRow}>
        {ITEMS.map((name) => {
          const used = dropped.includes(name);
          return (
            <div
              key={name}
              data-testid={`drag-${name.toLowerCase()}`}
              draggable={!used && !done}
              style={used || done ? styles.cardFaded : styles.card}
              onDragStart={(event) => handleDragStart(event, name)}
            >
              {name}
            </div>
          );
        })}
      </div>
      <div
        data-testid="dropzone"
        style={styles.dropzone}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        {dropped.length === 0 ? (
          <span style={styles.dropzoneEmpty}>Drop items here</span>
        ) : (
          dropped.map((name) => (
            <span key={name} style={styles.droppedItem}>
              {name}
            </span>
          ))
        )}
      </div>
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
      {done ? (
        <p data-testid="success-message" style={styles.successText}>
          Items dropped in the right order
        </p>
      ) : null}
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
  itemsRow: {
    display: "flex",
    gap: 12,
    justifyContent: "center",
  },
  card: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 600,
    backgroundColor: "#fff",
    cursor: "grab",
    userSelect: "none",
  },
  cardFaded: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 600,
    backgroundColor: "#fff",
    cursor: "default",
    userSelect: "none",
    opacity: 0.35,
  },
  dropzone: {
    minHeight: 120,
    border: "2px dashed #ccc",
    borderRadius: 8,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 12,
  },
  dropzoneEmpty: {
    fontSize: 14,
    color: "#666",
  },
  droppedItem: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 15,
    fontWeight: 600,
    backgroundColor: "#f4f4f4",
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    margin: 0,
    textAlign: "center",
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
