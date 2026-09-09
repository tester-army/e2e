"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";

const ACCESS_CODE = "SHADOW-42";

/**
 * A form buried in nested shadow roots. The React host div receives an OPEN
 * shadow root, and inside it an imperatively-built wrapper receives a CLOSED
 * shadow root that holds the actual input and submit button. CSS selectors,
 * querySelector, and DOM snapshots cannot pierce the closed root, so the form
 * controls are invisible to structural tooling - the agent must act on what
 * is visually on screen. Submission crosses the boundary via a composed
 * CustomEvent that the light-DOM host listens for.
 */
export default function ShadowDomForm() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const closedErrorRef = useRef<HTMLParagraphElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    if (!host.shadowRoot) {
      buildShadowForm(host, closedErrorRef);
    }

    /**
     * Receives the composed submit event dispatched from inside the closed
     * shadow root and validates the entered code in the light DOM.
     */
    const handleShadowSubmit = (event: Event) => {
      const value = (event as CustomEvent<string>).detail;
      if (value.trim() === ACCESS_CODE) {
        setError(null);
        if (closedErrorRef.current) {
          closedErrorRef.current.textContent = "";
        }
        setUnlocked(true);
        return;
      }
      const message = "Wrong access code";
      setError(message);
      if (closedErrorRef.current) {
        closedErrorRef.current.textContent = message;
      }
    };

    host.addEventListener("shadow-submit", handleShadowSubmit);
    return () => {
      host.removeEventListener("shadow-submit", handleShadowSubmit);
    };
  }, []);

  if (unlocked) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Access granted
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        The form below lives inside a closed shadow root. Enter {ACCESS_CODE} and press Submit.
      </p>
      <div ref={hostRef} />
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Attaches an open shadow root to the host, then builds a wrapper element
 * with a CLOSED shadow root containing the hint, input, error slot, and
 * submit button. The closed root reference is never exposed; only the error
 * paragraph is kept on a ref so validation can re-render its text node.
 */
function buildShadowForm(
  host: HTMLDivElement,
  closedErrorRef: { current: HTMLParagraphElement | null },
) {
  const openRoot = host.attachShadow({ mode: "open" });
  const wrapper = document.createElement("div");
  openRoot.appendChild(wrapper);

  const closedRoot = wrapper.attachShadow({ mode: "closed" });

  const inner = document.createElement("div");
  inner.style.cssText = "display:flex;flex-direction:column;gap:12px;";

  const hint = document.createElement("p");
  hint.textContent = `Access code hint: ${ACCESS_CODE}`;
  hint.style.cssText = "font-size:13px;color:#666;margin:0;";

  const input = document.createElement("input");
  input.placeholder = "Access code";
  input.style.cssText = "border:1px solid #ccc;border-radius:8px;padding:10px 12px;font-size:16px;";

  const errorText = document.createElement("p");
  errorText.style.cssText = "color:#c00;font-size:14px;margin:0;";
  closedErrorRef.current = errorText;

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Submit";
  button.style.cssText =
    "background-color:#111;color:#fff;border:none;border-radius:8px;" +
    "padding:12px 16px;font-size:16px;font-weight:600;cursor:pointer;";
  button.addEventListener("click", () => {
    button.dispatchEvent(
      new CustomEvent<string>("shadow-submit", {
        bubbles: true,
        composed: true,
        detail: input.value,
      }),
    );
  });

  inner.appendChild(hint);
  inner.appendChild(input);
  inner.appendChild(errorText);
  inner.appendChild(button);
  closedRoot.appendChild(inner);
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
    margin: "0 0 16px",
  },
} satisfies Record<string, CSSProperties>;
