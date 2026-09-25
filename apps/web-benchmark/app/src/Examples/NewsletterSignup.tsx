"use client";

import { type CSSProperties, useState } from "react";

export default function NewsletterSignup() {
  const [email, setEmail] = useState("");

  /**
   * Handles the subscribe click.
   * PLANTED BUG (do not fix): the submit handler crashes before any feedback
   * renders - no confirmation, no error message, only a console error. The
   * button looks alive but subscribing is impossible.
   */
  const handleSubscribe = () => {
    console.error(
      "Uncaught TypeError: Cannot read properties of undefined (reading 'subscribe')",
      "\n    at handleSubscribe (newsletter-signup.js:42:19)",
    );
  };

  return (
    <div style={styles.container}>
      <p style={styles.pitch}>Get one email a month with product updates. No spam, ever.</p>
      <input
        data-testid="email-input"
        style={styles.input}
        placeholder="you@example.com"
        type="email"
        autoCapitalize="none"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <button
        type="button"
        data-testid="subscribe-button"
        style={styles.button}
        onClick={handleSubscribe}
      >
        Subscribe
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
  pitch: {
    fontSize: 14,
    color: "#333",
    margin: 0,
  },
  input: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 16,
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
} satisfies Record<string, CSSProperties>;
