"use client";

import { type CSSProperties, useState } from "react";

const VALID_EMAIL = "tester@tester.army";
const VALID_PASSWORD = "benchmark123";

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

  /**
   * Validates the credentials against the hardcoded benchmark account and
   * moves the screen into the logged-in success state on match.
   */
  const handleSubmit = () => {
    if (!email.includes("@")) {
      setError("Enter a valid email address");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (email !== VALID_EMAIL || password !== VALID_PASSWORD) {
      setError("Invalid credentials");
      return;
    }
    setError(null);
    setLoggedIn(true);
  };

  if (loggedIn) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Logged in successfully
        </p>
        <button
          type="button"
          data-testid="logout-button"
          style={styles.button}
          onClick={() => {
            setLoggedIn(false);
            setEmail("");
            setPassword("");
          }}
        >
          Log out
        </button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Use {VALID_EMAIL} / {VALID_PASSWORD}
      </p>
      <input
        data-testid="email-input"
        style={styles.input}
        placeholder="Email"
        type="email"
        autoCapitalize="none"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <input
        data-testid="password-input"
        style={styles.input}
        placeholder="Password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
      <button type="button" data-testid="login-button" style={styles.button} onClick={handleSubmit}>
        Log in
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
