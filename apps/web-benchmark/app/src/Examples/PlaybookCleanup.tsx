"use client";

import { type CSSProperties, useState } from "react";

type Playbook = {
  id: string;
  name: string;
  rules: number;
};

const TARGET_NAME = "Launch Approval Draft";

const INITIAL_PLAYBOOKS: Playbook[] = [
  { id: "nda-review", name: "NDA Review", rules: 8 },
  { id: "launch-approval", name: TARGET_NAME, rules: 4 },
  { id: "vendor-onboarding", name: "Vendor Onboarding", rules: 6 },
];

/**
 * Regression scenario for post-delete reasoning. The only success evidence is
 * that an exact-name search no longer finds the playbook after confirmation.
 */
export default function PlaybookCleanup() {
  const [playbooks, setPlaybooks] = useState(INITIAL_PLAYBOOKS);
  const [query, setQuery] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Playbook | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredPlaybooks = playbooks.filter((playbook) =>
    playbook.name.toLowerCase().includes(normalizedQuery),
  );
  const targetDeleted = !playbooks.some((playbook) => playbook.name === TARGET_NAME);
  const exactDeletedSearch =
    targetDeleted &&
    normalizedQuery === TARGET_NAME.toLowerCase() &&
    filteredPlaybooks.length === 0;

  /** Removes the selected playbook and returns to the filtered list. */
  const removePlaybook = () => {
    if (!pendingRemoval) return;

    setPlaybooks((current) => current.filter((playbook) => playbook.id !== pendingRemoval.id));
    setPendingRemoval(null);
  };

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <div>
          <h2 style={styles.heading}>Playbooks</h2>
          <p style={styles.subheading}>Reusable review guidance for your team.</p>
        </div>
        <label style={styles.searchLabel}>
          Search playbooks
          <input
            type="search"
            value={query}
            placeholder="Search"
            style={styles.searchInput}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {filteredPlaybooks.length > 0 ? (
        <ul style={styles.list}>
          {filteredPlaybooks.map((playbook) => (
            <li key={playbook.id} style={styles.card}>
              <div>
                <h3 style={styles.cardTitle}>{playbook.name}</h3>
                <p style={styles.cardMeta}>
                  {playbook.rules} {playbook.rules === 1 ? "rule" : "rules"}
                </p>
              </div>
              <div style={styles.menuContainer}>
                <button
                  type="button"
                  aria-label={`More actions for ${playbook.name}`}
                  aria-haspopup="menu"
                  aria-expanded={openMenuId === playbook.id}
                  style={styles.menuButton}
                  onClick={() =>
                    setOpenMenuId((current) => (current === playbook.id ? null : playbook.id))
                  }
                >
                  ⋯
                </button>
                {openMenuId === playbook.id ? (
                  <div role="menu" aria-label={`Actions for ${playbook.name}`} style={styles.menu}>
                    <button
                      type="button"
                      role="menuitem"
                      style={styles.deleteButton}
                      onClick={() => {
                        setPendingRemoval(playbook);
                        setOpenMenuId(null);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p
          data-testid={exactDeletedSearch ? "success-message" : "empty-state"}
          style={styles.emptyState}
        >
          No playbooks match &quot;{query.trim()}&quot;.
        </p>
      )}

      {pendingRemoval ? (
        <div style={styles.overlay}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-playbook-title"
            style={styles.dialog}
          >
            <h2 id="remove-playbook-title" style={styles.dialogTitle}>
              Remove Playbook
            </h2>
            <p style={styles.dialogText}>
              Are you sure you want to remove &quot;{pendingRemoval.name}&quot;?
            </p>
            <div style={styles.dialogActions}>
              <button
                type="button"
                style={styles.cancelButton}
                onClick={() => setPendingRemoval(null)}
              >
                Cancel
              </button>
              <button type="button" style={styles.removeButton} onClick={removePlaybook}>
                Remove
              </button>
            </div>
          </section>
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
  toolbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 16,
  },
  heading: {
    fontSize: 18,
    margin: 0,
  },
  subheading: {
    color: "#666",
    fontSize: 13,
    margin: "4px 0 0",
  },
  searchLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    color: "#555",
    fontSize: 12,
  },
  searchInput: {
    width: 220,
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "9px 11px",
    fontSize: 14,
  },
  list: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 12,
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  card: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    minHeight: 84,
    border: "1px solid #ddd",
    borderRadius: 10,
    padding: 14,
  },
  cardTitle: {
    fontSize: 15,
    margin: 0,
  },
  cardMeta: {
    color: "#777",
    fontSize: 12,
    margin: "6px 0 0",
  },
  menuContainer: {
    position: "relative",
  },
  menuButton: {
    width: 32,
    height: 28,
    border: "1px solid #ccc",
    borderRadius: 6,
    backgroundColor: "#fff",
    cursor: "pointer",
    fontSize: 18,
    lineHeight: 1,
  },
  menu: {
    position: "absolute",
    zIndex: 2,
    top: 32,
    right: 0,
    minWidth: 100,
    border: "1px solid #ddd",
    borderRadius: 8,
    backgroundColor: "#fff",
    padding: 4,
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
  },
  deleteButton: {
    width: "100%",
    border: "none",
    borderRadius: 5,
    backgroundColor: "transparent",
    color: "#b42318",
    cursor: "pointer",
    padding: "8px 10px",
    textAlign: "left",
  },
  emptyState: {
    border: "1px dashed #ccc",
    borderRadius: 10,
    color: "#555",
    margin: 0,
    padding: 28,
    textAlign: "center",
  },
  overlay: {
    position: "fixed",
    zIndex: 10,
    inset: 0,
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    padding: 24,
  },
  dialog: {
    width: "min(420px, 100%)",
    borderRadius: 12,
    backgroundColor: "#fff",
    padding: 20,
    boxShadow: "0 18px 50px rgba(0, 0, 0, 0.2)",
  },
  dialogTitle: {
    fontSize: 18,
    margin: 0,
  },
  dialogText: {
    color: "#555",
    fontSize: 14,
    margin: "10px 0 20px",
  },
  dialogActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
  },
  cancelButton: {
    border: "1px solid #ccc",
    borderRadius: 7,
    backgroundColor: "#fff",
    cursor: "pointer",
    padding: "8px 12px",
  },
  removeButton: {
    border: "1px solid #b42318",
    borderRadius: 7,
    backgroundColor: "#b42318",
    color: "#fff",
    cursor: "pointer",
    padding: "8px 12px",
  },
} satisfies Record<string, CSSProperties>;
