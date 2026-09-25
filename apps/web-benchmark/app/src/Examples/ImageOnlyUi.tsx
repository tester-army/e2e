"use client";

import { type CSSProperties, useEffect, useState } from "react";

const SEQUENCE = ["star", "heart"] as const;

type Icon = "star" | "heart" | "bolt";

/**
 * Deliberately hostile accessibility: every piece of text on this screen is a
 * runtime-rendered PNG (canvas data URL) with an empty alt, and the buttons
 * are icon-only inline SVGs with no labels, roles, or test ids. The DOM
 * carries zero readable text, so text extraction and a11y snapshots are
 * useless - the agent must read the instruction image and click the icons in
 * the right order purely from pixels.
 */
export default function ImageOnlyUi() {
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const [images, setImages] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    setImages({
      instruction: textImage("Click the star, then the heart", "#111"),
      error: textImage("Wrong icon, start over", "#c00"),
      success: textImage("Icons verified", "#0a0"),
    });
  }, []);

  /**
   * Advances the sequence when the clicked icon matches the next expected
   * one; any other icon shows the error image and resets progress.
   */
  const handleIcon = (icon: Icon) => {
    if (progress >= SEQUENCE.length) return;
    if (icon !== SEQUENCE[progress]) {
      setFailed(true);
      setProgress(0);
      return;
    }
    setFailed(false);
    setProgress(progress + 1);
  };

  if (!images) return <div style={styles.container} />;

  const done = progress >= SEQUENCE.length;

  return (
    <div style={styles.container}>
      {done ? (
        <img src={images.success} alt="" style={styles.bigTextImage} />
      ) : (
        <img src={images.instruction} alt="" style={styles.textImage} />
      )}
      {!done ? (
        <div style={styles.iconRow}>
          <div style={styles.iconTile} onClick={() => handleIcon("bolt")}>
            <BoltIcon />
          </div>
          <div style={styles.iconTile} onClick={() => handleIcon("star")}>
            <StarIcon />
          </div>
          <div style={styles.iconTile} onClick={() => handleIcon("heart")}>
            <HeartIcon />
          </div>
        </div>
      ) : null}
      {!done && failed ? <img src={images.error} alt="" style={styles.textImage} /> : null}
      {!done ? (
        <div style={styles.dotRow}>
          {SEQUENCE.map((step, index) => (
            <div
              key={step}
              style={{
                ...styles.dot,
                backgroundColor: index < progress ? "#111" : "#ddd",
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Renders a line of text into an offscreen canvas and returns it as a PNG
 * data URL, keeping the text itself out of the DOM entirely.
 */
function textImage(text: string, color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 48;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.font = "600 22px -apple-system, sans-serif";
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 320, 24);
  return canvas.toDataURL("image/png");
}

function StarIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2l-6.1 3.4 1.4-6.8L2.2 9.1l6.9-.8L12 2z"
        fill="#444"
      />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 21s-7.5-4.8-10-9.3C.4 8.6 2.3 5 5.7 5c2 0 3.4 1.1 4.3 2.5h4C14.9 6.1 16.3 5 18.3 5c3.4 0 5.3 3.6 3.7 6.7C19.5 16.2 12 21 12 21z"
        fill="#444"
      />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" fill="#444" />
    </svg>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
    padding: "24px 0",
    minHeight: 220,
  },
  textImage: {
    width: 320,
    height: 24,
  },
  bigTextImage: {
    width: 380,
    height: 28,
  },
  iconRow: {
    display: "flex",
    gap: 16,
  },
  iconTile: {
    width: 88,
    height: 88,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid #ccc",
    borderRadius: 8,
    cursor: "default",
    userSelect: "none",
  },
  dotRow: {
    display: "flex",
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
} satisfies Record<string, CSSProperties>;
