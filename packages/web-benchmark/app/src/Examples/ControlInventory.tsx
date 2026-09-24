"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

const SIZES = ["Small", "Medium", "Large"] as const;
const INITIAL_FILES = ["quarterly-report.pdf", "report.pdf", "notes.txt"];
const TARGET_FILE = "report.pdf";
const RENAMED_FILE = "summary.pdf";
const LONG_PRESS_MS = 500;
const DETAILS_QUERY = "view=details";

type Size = (typeof SIZES)[number];
type View = "inventory" | "details";

/**
 * Reads which view the current URL names, the way the popstate listener does.
 */
const viewFromLocation = (): View => (window.location.search.includes(DETAILS_QUERY) ? "details" : "inventory");

/**
 * The deterministic contract surface: plain controls with every state
 * exposed, one exercise per agent verb the hard scenarios never reach (a
 * checkbox and a radio to set, a long press and a double click to tell from a
 * tap, a context menu that opens on right-click only, a file input, the
 * browser history, a paragraph to scroll into view). Not a hard surface: each
 * control reports its state in a status line, and the success message shows
 * once every exercise is done. Ours, like the mobile benchmark's Control
 * Inventory, not a copy from the tester-army benchmark.
 */
export default function ControlInventory() {
  const [agreed, setAgreed] = useState(false);
  const [size, setSize] = useState<Size | null>(null);
  const [holdState, setHoldState] = useState("none");
  const [longPressed, setLongPressed] = useState(false);
  const [doubleClickState, setDoubleClickState] = useState("none");
  const [doubleClicked, setDoubleClicked] = useState(false);
  const [files, setFiles] = useState(INITIAL_FILES);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [fileState, setFileState] = useState("no menu open");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [view, setView] = useState<View>("inventory");
  const [returned, setReturned] = useState(false);
  const [footnoteInView, setFootnoteInView] = useState(false);
  const [footnoteSeen, setFootnoteSeen] = useState(false);
  const heldAt = useRef(0);
  const openedDetails = useRef(false);
  const footnoteRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const onPopState = () => {
      const next = viewFromLocation();
      setView(next);
      if (next === "inventory" && openedDetails.current) setReturned(true);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const footnote = footnoteRef.current;
    if (!footnote) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries[0]?.isIntersecting === true;
      setFootnoteInView(visible);
      if (visible) setFootnoteSeen(true);
    });
    observer.observe(footnote);
    return () => observer.disconnect();
  }, [view]);

  const renamed = files.includes(RENAMED_FILE) && !files.includes(TARGET_FILE);
  const done =
    agreed &&
    size === "Medium" &&
    longPressed &&
    doubleClicked &&
    renamed &&
    attachments.length > 0 &&
    returned &&
    footnoteSeen;

  const handleHoldRelease = () => {
    const held = performance.now() - heldAt.current;
    if (held >= LONG_PRESS_MS) {
      setHoldState("long-pressed");
      setLongPressed(true);
    } else {
      setHoldState("tapped");
    }
  };

  const handleMenuAction = (file: string, action: string) => {
    setMenuFor(null);
    if (action !== "Rename") {
      setFileState("that is not the action");
      return;
    }
    if (file !== TARGET_FILE) {
      setFileState("that is not the file");
      return;
    }
    setFiles((current) => current.map((entry) => (entry === file ? RENAMED_FILE : entry)));
    setFileState(`${TARGET_FILE} renamed to ${RENAMED_FILE}`);
  };

  const openDetails = () => {
    openedDetails.current = true;
    window.history.pushState({}, "", `?${DETAILS_QUERY}`);
    setView("details");
  };

  return (
    <div style={styles.container}>
      {done ? (
        <p data-testid="success-message" style={styles.successText}>
          All exercises done
        </p>
      ) : null}
      <p style={styles.hint}>
        Plain controls, one exercise each. Agree to the terms and pick the Medium size; hold the Hold me button, then
        double-click the Double-click me button; rename report.pdf to summary.pdf through its context menu, which opens
        on right-click only; attach a file; open the details and return with the browser history; bring the footnote at
        the bottom into view.
      </p>

      <dl style={styles.statusList} aria-label="Exercise states">
        <dt style={styles.statusTerm}>Toggles</dt>
        <dd style={styles.statusValue}>
          <output aria-label="Toggles state">{`${agreed ? "terms agreed" : "terms not agreed"}, size ${size ?? "unset"}`}</output>
        </dd>
        <dt style={styles.statusTerm}>Hold</dt>
        <dd style={styles.statusValue}>
          <output aria-label="Hold state">{holdState}</output>
        </dd>
        <dt style={styles.statusTerm}>Double-click</dt>
        <dd style={styles.statusValue}>
          <output aria-label="Double-click state">{doubleClickState}</output>
        </dd>
        <dt style={styles.statusTerm}>File</dt>
        <dd style={styles.statusValue}>
          <output aria-label="File state">{fileState}</output>
        </dd>
        <dt style={styles.statusTerm}>Attachments</dt>
        <dd style={styles.statusValue}>
          <output aria-label="Attachments state">{attachments.length === 0 ? "none" : attachments.join(", ")}</output>
        </dd>
        <dt style={styles.statusTerm}>Navigation</dt>
        <dd style={styles.statusValue}>
          <output aria-label="Navigation state">
            {view === "details" ? "on details" : returned ? "back on the inventory" : "not opened"}
          </output>
        </dd>
        <dt style={styles.statusTerm}>Scroll</dt>
        <dd style={styles.statusValue}>
          <output aria-label="Footnote state">{footnoteInView ? "in view" : "out of view"}</output>
        </dd>
      </dl>

      {view === "details" ? (
        <section aria-label="Details" style={styles.section}>
          <h2 style={styles.sectionTitle}>Details</h2>
          <p style={styles.text}>The inventory is one history entry back. This view has no link of its own.</p>
        </section>
      ) : (
        <>
          <section aria-label="Toggles" style={styles.section}>
            <h2 style={styles.sectionTitle}>Toggles</h2>
            <label style={styles.checkRow}>
              <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
              Agree to terms
            </label>
            <fieldset style={styles.fieldset}>
              <legend style={styles.legend}>Size</legend>
              {SIZES.map((option) => (
                <label key={option} style={styles.checkRow}>
                  <input type="radio" name="size" value={option} checked={size === option} onChange={() => setSize(option)} />
                  {option}
                </label>
              ))}
            </fieldset>
          </section>

          <section aria-label="Gestures" style={styles.section}>
            <h2 style={styles.sectionTitle}>Gestures</h2>
            <div style={styles.buttonRow}>
              <button
                type="button"
                style={styles.button}
                onPointerDown={() => {
                  heldAt.current = performance.now();
                }}
                onPointerUp={handleHoldRelease}
              >
                Hold me
              </button>
              <button
                type="button"
                style={styles.button}
                onClick={() => setDoubleClickState("clicked once")}
                onDoubleClick={() => {
                  setDoubleClickState("double-clicked");
                  setDoubleClicked(true);
                }}
              >
                Double-click me
              </button>
            </div>
          </section>

          <section aria-label="Files" style={styles.section}>
            <h2 style={styles.sectionTitle}>Files</h2>
            <ul style={styles.fileList}>
              {files.map((file) => (
                <li key={file} style={styles.fileRow}>
                  <span
                    style={styles.fileName}
                    onClick={() => setFileState("a click selects nothing; the menu opens on right-click")}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenuFor(file);
                      setFileState(`menu open for ${file}`);
                    }}
                  >
                    {file}
                  </span>
                  {menuFor === file ? (
                    <div role="menu" aria-label={`${file} actions`} style={styles.menu}>
                      {["Rename", "Duplicate", "Delete"].map((action) => (
                        <button
                          key={action}
                          type="button"
                          role="menuitem"
                          style={styles.menuItem}
                          onClick={() => handleMenuAction(file, action)}
                        >
                          {action}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            <label style={styles.checkRow}>
              Attachments
              <input
                type="file"
                multiple
                onChange={(event) => setAttachments(Array.from(event.target.files ?? [], (file) => file.name))}
              />
            </label>
          </section>

          <section aria-label="Navigation" style={styles.section}>
            <h2 style={styles.sectionTitle}>Navigation</h2>
            <button type="button" style={styles.button} onClick={openDetails}>
              Open details
            </button>
          </section>

          <p ref={footnoteRef} style={styles.footnote}>
            Footnote
          </p>
        </>
      )}
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
  hint: {
    fontSize: 13,
    color: "#666",
    margin: 0,
    lineHeight: 1.5,
  },
  successText: {
    fontSize: 18,
    fontWeight: 700,
    color: "#0a7a2f",
    margin: 0,
  },
  statusList: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: 12,
    rowGap: 4,
    margin: 0,
    padding: 12,
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    fontSize: 13,
  },
  statusTerm: {
    color: "#666",
  },
  statusValue: {
    margin: 0,
    color: "#111",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
    border: "1px solid #e5e5e5",
    borderRadius: 8,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: 600,
    margin: 0,
  },
  text: {
    fontSize: 14,
    color: "#333",
    margin: 0,
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
  },
  fieldset: {
    display: "flex",
    gap: 16,
    border: "none",
    margin: 0,
    padding: 0,
  },
  legend: {
    fontSize: 13,
    color: "#666",
    padding: 0,
  },
  buttonRow: {
    display: "flex",
    gap: 12,
  },
  button: {
    fontSize: 14,
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid #ccc",
    backgroundColor: "#fafafa",
    cursor: "pointer",
  },
  fileList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  fileRow: {
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  fileName: {
    fontSize: 14,
    padding: "6px 8px",
    borderRadius: 6,
    cursor: "default",
    userSelect: "none",
  },
  menu: {
    position: "absolute",
    top: "100%",
    left: 0,
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
    textAlign: "left",
    padding: "8px 10px",
    borderRadius: 6,
    border: "none",
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  footnote: {
    marginTop: 1600,
    fontSize: 13,
    color: "#666",
  },
} satisfies Record<string, CSSProperties>;
