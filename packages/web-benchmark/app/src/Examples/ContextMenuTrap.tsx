"use client";

import { type CSSProperties, useState } from "react";

const INITIAL_FILES = ["quarterly-report.pdf", "report.pdf", "notes.txt"];

const TARGET_FILE = "report.pdf";
const TARGET_NAME = "summary.pdf";

/**
 * Sabotage scenario distilled from a real customer run: the app's own copy
 * steers users toward right-clicking, but the agent has no right-click and a
 * native context menu would be invisible to it anyway (its snapshots and
 * screenshots never show browser chrome). The page deliberately has no
 * contextmenu handler, so right-click attempts produce nothing app-visible.
 * The agent must ignore the right-click affordance and rename through the
 * per-row "⋯" menu instead. Decoy menu items punish guessing.
 */
export default function ContextMenuTrap() {
  const [files, setFiles] = useState(INITIAL_FILES);
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const renamed = files.includes(TARGET_NAME) && !files.includes(TARGET_FILE);

  const handleMenuAction = (file: string, action: string) => {
    setOpenMenuFor(null);
    if (action === "Rename") {
      setRenaming(file);
      setDraftName(file);
      setNotice(null);
      return;
    }
    if (action === "Duplicate") {
      setNotice("Duplicating is disabled for sample files");
      return;
    }
    setNotice("Sample files cannot be deleted");
  };

  const handleRenameSave = (file: string) => {
    const nextName = draftName.trim();
    if (!nextName) {
      setNotice("Name cannot be empty");
      return;
    }
    setFiles((current) => current.map((name) => (name === file ? nextName : name)));
    setRenaming(null);
    setNotice(null);
  };

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>My Files</h2>
      <p style={styles.hint}>Tip: right-click a file to manage it.</p>
      <div style={styles.fileList}>
        {files.map((file) => (
          <div key={file} style={styles.fileRow}>
            {renaming === file ? (
              <>
                <input
                  autoFocus
                  aria-label="New file name"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  style={styles.renameInput}
                />
                <button
                  type="button"
                  style={styles.saveButton}
                  onClick={() => handleRenameSave(file)}
                >
                  Save
                </button>
              </>
            ) : (
              <>
                <span style={styles.fileName}>{file}</span>
                <div style={styles.menuAnchor}>
                  <button
                    type="button"
                    aria-label={`More actions for ${file}`}
                    style={styles.kebabButton}
                    onClick={() => setOpenMenuFor(openMenuFor === file ? null : file)}
                  >
                    ⋯
                  </button>
                  {openMenuFor === file ? (
                    <div style={styles.menu}>
                      {["Rename", "Duplicate", "Delete"].map((action) => (
                        <button
                          key={action}
                          type="button"
                          style={styles.menuItem}
                          onClick={() => handleMenuAction(file, action)}
                        >
                          {action}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {notice ? (
        <p data-testid="notice-message" style={styles.noticeText}>
          {notice}
        </p>
      ) : null}
      {renamed ? (
        <p data-testid="success-message" style={styles.successText}>
          File renamed to {TARGET_NAME}
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
    maxWidth: 420,
    margin: "0 auto",
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    margin: 0,
  },
  hint: {
    fontSize: 13,
    color: "#666",
    margin: 0,
  },
  fileList: {
    display: "flex",
    flexDirection: "column",
    border: "1px solid #e5e5e5",
    borderRadius: 8,
  },
  fileRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "10px 12px",
    borderBottom: "1px solid #f0f0f0",
  },
  fileName: {
    fontSize: 15,
    color: "#111",
  },
  menuAnchor: {
    position: "relative",
  },
  kebabButton: {
    fontSize: 16,
    lineHeight: 1,
    padding: "4px 8px",
    border: "1px solid #e5e5e5",
    borderRadius: 6,
    backgroundColor: "#fff",
    cursor: "pointer",
  },
  menu: {
    position: "absolute",
    top: "100%",
    right: 0,
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    minWidth: 140,
    backgroundColor: "#fff",
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
    padding: 4,
  },
  menuItem: {
    fontSize: 14,
    color: "#333",
    padding: "8px 10px",
    border: "none",
    borderRadius: 6,
    backgroundColor: "transparent",
    cursor: "pointer",
    textAlign: "left",
  },
  renameInput: {
    flex: 1,
    fontSize: 14,
    padding: "6px 8px",
    border: "1px solid #ccc",
    borderRadius: 6,
  },
  saveButton: {
    fontSize: 14,
    padding: "6px 12px",
    border: "none",
    borderRadius: 6,
    backgroundColor: "#111",
    color: "#fff",
    cursor: "pointer",
  },
  noticeText: {
    color: "#c00",
    fontSize: 14,
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
