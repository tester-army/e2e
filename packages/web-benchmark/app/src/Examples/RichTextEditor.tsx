"use client";

import { type CSSProperties, useRef, useState } from "react";

const REQUIRED_TEXT = "release approved";
const BOLD_WORD = "approved";

/**
 * Normalizes editor text for comparison: trims, collapses whitespace runs to
 * single spaces, and lowercases.
 */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Flattens the editor into its non-whitespace characters in document order,
 * each tagged with whether a bold element wraps it. Checking bold per
 * character, rather than per element, is what rejects a selection that bolds
 * "lease approved" or splits a word across two bold runs.
 */
function boldCharacters(editor: HTMLElement): { char: string; bold: boolean }[] {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const characters: { char: string; bold: boolean }[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const bold = (node.parentElement?.closest("b, strong") ?? null) !== null;
    for (const char of node.textContent ?? "") {
      if (/\S/.test(char)) {
        characters.push({ char: char.toLowerCase(), bold });
      }
    }
  }
  return characters;
}

/**
 * Rich text scenario: the check passes only when the document text is exactly
 * REQUIRED_TEXT and bold formatting wraps the word "approved" but never
 * "release" - so the agent must apply bold to a precise selection.
 */
export default function RichTextEditor() {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  /**
   * Toggles bold on the current selection. The button prevents default on
   * mousedown so the editor keeps focus and its selection survives the click.
   * document.execCommand is deprecated but still universally supported in
   * browsers, which is fine for a deterministic benchmark scenario.
   */
  const handleBold = () => {
    editorRef.current?.focus();
    document.execCommand("bold");
  };

  /**
   * Reads the live editor DOM and verifies both conditions: exact normalized
   * text, and bold covering every character of "approved" and nothing else.
   */
  const handleCheck = () => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    if (normalizeText(editor.textContent ?? "") !== REQUIRED_TEXT) {
      setError(`Text must be exactly "${REQUIRED_TEXT}"`);
      return;
    }
    const characters = boldCharacters(editor);
    const boldFrom = REQUIRED_TEXT.replace(/\s/g, "").indexOf(BOLD_WORD);
    const boldIsExact = characters.every(({ bold }, index) => bold === index >= boldFrom);
    if (!boldIsExact) {
      setError(`Only the word ${BOLD_WORD} must be bold`);
      return;
    }
    setError(null);
    setApproved(true);
  };

  if (approved) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Document approved
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Type &quot;{REQUIRED_TEXT}&quot; in the editor and make the word {BOLD_WORD} bold, then
        check the document.
      </p>
      <div style={styles.toolbar}>
        <button
          type="button"
          data-testid="bold-button"
          style={styles.boldButton}
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleBold}
        >
          B
        </button>
      </div>
      <div
        data-testid="editor"
        ref={editorRef}
        style={styles.editor}
        contentEditable
        suppressContentEditableWarning
      />
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
      <button type="button" data-testid="check-button" style={styles.button} onClick={handleCheck}>
        Check document
      </button>
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
  toolbar: {
    display: "flex",
    gap: 8,
  },
  boldButton: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
    width: 44,
  },
  editor: {
    minHeight: 140,
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    outline: "none",
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
