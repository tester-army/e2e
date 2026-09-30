"use client";

import { type CSSProperties, useEffect, useState } from "react";

/** Posts one action to the scenario's mail endpoint; a failure comes back as its `error`. */
async function post<T extends object>(body: Record<string, string>): Promise<T | { error: string }> {
  const response = await fetch("/api/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T | { error: string };
}

export default function EmailVerification() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [signup, setSignup] = useState("");
  const [verified, setVerified] = useState("");
  const [linkEmail, setLinkEmail] = useState("");
  const [link, setLink] = useState("");
  const [inviter, setInviter] = useState("");
  const [invitee, setInvitee] = useState("");
  const [invite, setInvite] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token === null) return;
    void post<{ email: string | null }>({ action: "redeem", token }).then((result) =>
      setLink("error" in result ? result.error : result.email === null ? "This sign-in link is not valid" : `Signed in as ${result.email}`),
    );
  }, []);

  return (
    <div style={styles.container}>
      <section style={styles.section} aria-labelledby="signup-heading">
        <h2 id="signup-heading" style={styles.heading}>
          Create an account
        </h2>
        <label style={styles.label}>
          Email
          <input style={styles.input} type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <button
          type="button"
          style={styles.button}
          onClick={async () => {
            const result = await post({ action: "signup", email });
            setSignup("error" in result ? result.error : `We sent a code to ${email}`);
          }}
        >
          Sign up
        </button>
        <label style={styles.label}>
          Verification code
          <input style={styles.input} inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} />
        </label>
        <div style={styles.row}>
          <button
            type="button"
            style={styles.button}
            onClick={async () => {
              const result = await post<{ verified: boolean }>({ action: "verify", email, code });
              if ("error" in result) setSignup(result.error);
              else if (result.verified) setVerified(`Email verified for ${email}`);
              else setSignup("That code is not valid");
            }}
          >
            Verify
          </button>
          <button
            type="button"
            style={styles.secondary}
            onClick={async () => {
              const result = await post({ action: "resend", email });
              setSignup("error" in result ? result.error : `We sent a new code to ${email}`);
            }}
          >
            Resend code
          </button>
        </div>
        <p role="status" aria-label="Sign-up state" style={styles.status}>
          {signup}
        </p>
        {verified === "" ? null : (
          <p data-testid="success-message" style={styles.success}>
            {verified}
          </p>
        )}
      </section>

      <section style={styles.section} aria-labelledby="link-heading">
        <h2 id="link-heading" style={styles.heading}>
          Sign in with a link
        </h2>
        <label style={styles.label}>
          Sign-in email
          <input style={styles.input} type="email" value={linkEmail} onChange={(event) => setLinkEmail(event.target.value)} />
        </label>
        <button
          type="button"
          style={styles.button}
          onClick={async () => {
            const result = await post({ action: "magic-link", email: linkEmail });
            setLink("error" in result ? result.error : `We sent a sign-in link to ${linkEmail}`);
          }}
        >
          Email me a link
        </button>
        <p role="status" aria-label="Sign-in state" style={styles.status}>
          {link}
        </p>
      </section>

      <section style={styles.section} aria-labelledby="invite-heading">
        <h2 id="invite-heading" style={styles.heading}>
          Invite a teammate
        </h2>
        <label style={styles.label}>
          Your email
          <input style={styles.input} type="email" value={inviter} onChange={(event) => setInviter(event.target.value)} />
        </label>
        <label style={styles.label}>
          Teammate&apos;s email
          <input style={styles.input} type="email" value={invitee} onChange={(event) => setInvitee(event.target.value)} />
        </label>
        <button
          type="button"
          style={styles.button}
          onClick={async () => {
            const result = await post({ action: "invite", from: inviter, to: invitee });
            setInvite("error" in result ? result.error : `Invite sent to ${invitee}, with a copy to you`);
          }}
        >
          Send invite
        </button>
        <p role="status" aria-label="Invite state" style={styles.status}>
          {invite}
        </p>
      </section>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 24,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 16,
    border: "1px solid #e5e5e5",
    borderRadius: 8,
  },
  heading: {
    fontSize: 16,
    fontWeight: 600,
    margin: 0,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 13,
    color: "#333",
  },
  input: {
    padding: "8px 10px",
    fontSize: 14,
    border: "1px solid #ccc",
    borderRadius: 6,
  },
  row: {
    display: "flex",
    gap: 8,
  },
  button: {
    padding: "8px 14px",
    fontSize: 14,
    background: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    alignSelf: "flex-start",
  },
  secondary: {
    padding: "8px 14px",
    fontSize: 14,
    background: "#fff",
    color: "#111",
    border: "1px solid #ccc",
    borderRadius: 6,
    cursor: "pointer",
  },
  status: {
    minHeight: 20,
    fontSize: 14,
    margin: 0,
  },
  success: {
    fontSize: 14,
    fontWeight: 600,
    color: "#15803d",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
