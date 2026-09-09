"use client";

import { type CSSProperties, type PointerEvent, useRef, useState } from "react";

type ColumnId = "todo" | "in-progress" | "done";

const DRAG_THRESHOLD_PX = 8;

const COLUMNS: { id: ColumnId; title: string }[] = [
  { id: "todo", title: "Todo" },
  { id: "in-progress", title: "In Progress" },
  { id: "done", title: "Done" },
];

const CARD_LABELS: Record<string, string> = {
  "fix-payment-bug": "Fix payment bug",
  "update-pricing-page": "Update pricing page",
  "refactor-onboarding": "Refactor onboarding",
  "polish-empty-states": "Polish empty states",
};

const INITIAL_BOARD: Record<ColumnId, string[]> = {
  todo: ["fix-payment-bug", "update-pricing-page", "refactor-onboarding"],
  "in-progress": ["polish-empty-states"],
  done: [],
};

const TARGET_BOARD: Record<ColumnId, string[]> = {
  todo: ["update-pricing-page"],
  "in-progress": ["polish-empty-states", "refactor-onboarding"],
  done: ["fix-payment-bug"],
};

type DragState = {
  cardId: string;
  fromColumn: ColumnId;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
};

/**
 * Sabotage scenario: a dnd-kit style kanban board driven purely by pointer
 * events. Nothing is HTML5 draggable, so dragstart/dragover/drop and
 * dataTransfer do nothing. A drag only activates after pointerdown followed
 * by pointer movement past an 8px threshold, and the drop column is resolved
 * from the pointerup coordinates. Plain clicks on cards are no-ops. The board
 * must match the target layout when Submit board is pressed.
 */
export default function KanbanBoard() {
  const [board, setBoard] = useState<Record<ColumnId, string[]>>(INITIAL_BOARD);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const columnRefs = useRef<Map<ColumnId, HTMLDivElement>>(new Map());

  const handlePointerDown = (
    event: PointerEvent<HTMLDivElement>,
    cardId: string,
    fromColumn: ColumnId,
  ) => {
    if (done) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      cardId,
      fromColumn,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
    });
  };

  /**
   * Tracks the captured pointer: activates the drag once movement passes the
   * threshold, then keeps the floating card glued to the pointer.
   */
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) {
      return;
    }
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.active && distance < DRAG_THRESHOLD_PX) {
      return;
    }
    setDrag({ ...drag, x: event.clientX, y: event.clientY, active: true });
  };

  /**
   * Resolves the drop column from the release coordinates against the live
   * column rects and moves the card there; a drag released outside every
   * column snaps the card back.
   */
  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) {
      return;
    }
    if (!drag.active) {
      setDrag(null);
      return;
    }
    let dropColumn: ColumnId | null = null;
    for (const [columnId, element] of columnRefs.current) {
      const rect = element.getBoundingClientRect();
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        dropColumn = columnId;
        break;
      }
    }
    if (dropColumn && dropColumn !== drag.fromColumn) {
      const target = dropColumn;
      setBoard((current) => ({
        ...current,
        [drag.fromColumn]: current[drag.fromColumn].filter((id) => id !== drag.cardId),
        [target]: [...current[target], drag.cardId],
      }));
      setError(null);
    }
    setDrag(null);
  };

  /**
   * Compares the board against the target layout, ignoring order within a
   * column, and flips to the terminal success state on a match.
   */
  const handleSubmit = () => {
    const matches = COLUMNS.every(({ id }) => {
      const actual = board[id].toSorted();
      const expected = TARGET_BOARD[id].toSorted();
      return (
        actual.length === expected.length &&
        actual.every((cardId, index) => cardId === expected[index])
      );
    });
    if (!matches) {
      setError("Board does not match the goal yet");
      return;
    }
    setError(null);
    setDone(true);
  };

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Move Fix payment bug to Done and Refactor onboarding to In Progress, then press Submit
        board.
      </p>
      <div style={styles.boardRow}>
        {COLUMNS.map((column) => (
          <div
            key={column.id}
            data-testid={`column-${column.id}`}
            ref={(element) => {
              if (element) {
                columnRefs.current.set(column.id, element);
              } else {
                columnRefs.current.delete(column.id);
              }
            }}
            style={styles.column}
          >
            <p style={styles.columnTitle}>{column.title}</p>
            {board[column.id].map((cardId) => {
              const lifted = drag?.active && drag.cardId === cardId;
              return (
                <div
                  key={cardId}
                  data-testid={`card-${cardId}`}
                  style={lifted ? styles.cardLifted : styles.card}
                  onPointerDown={(event) => handlePointerDown(event, cardId, column.id)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={() => setDrag(null)}
                >
                  {CARD_LABELS[cardId]}
                </div>
              );
            })}
            {board[column.id].length === 0 ? <p style={styles.emptyColumn}>Empty</p> : null}
          </div>
        ))}
      </div>
      {drag?.active ? (
        <div style={{ ...styles.ghost, left: drag.x + 8, top: drag.y + 8 }}>
          {CARD_LABELS[drag.cardId]}
        </div>
      ) : null}
      <button
        type="button"
        data-testid="submit-board"
        style={styles.submitButton}
        onClick={handleSubmit}
      >
        Submit board
      </button>
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
      {done ? (
        <p data-testid="success-message" style={styles.successText}>
          Board matches the goal
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
  boardRow: {
    display: "flex",
    gap: 12,
    alignItems: "stretch",
  },
  column: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: 12,
    minHeight: 220,
    backgroundColor: "#fafafa",
  },
  columnTitle: {
    fontSize: 13,
    fontWeight: 700,
    textTransform: "uppercase",
    color: "#666",
    margin: 0,
  },
  card: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    fontWeight: 600,
    backgroundColor: "#fff",
    cursor: "grab",
    userSelect: "none",
    touchAction: "none",
  },
  cardLifted: {
    border: "1px dashed #999",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    fontWeight: 600,
    backgroundColor: "#f0f0f0",
    color: "#aaa",
    cursor: "grabbing",
    userSelect: "none",
    touchAction: "none",
  },
  ghost: {
    position: "fixed",
    zIndex: 10,
    border: "1px solid #999",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    fontWeight: 600,
    backgroundColor: "#fff",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
    pointerEvents: "none",
  },
  emptyColumn: {
    fontSize: 13,
    color: "#aaa",
    textAlign: "center",
    margin: "auto 0",
  },
  submitButton: {
    alignSelf: "center",
    border: "1px solid #333",
    borderRadius: 8,
    padding: "10px 20px",
    fontSize: 15,
    fontWeight: 600,
    backgroundColor: "#fff",
    cursor: "pointer",
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
