"use client";

import { type CSSProperties, useEffect, useState } from "react";

const OVERLAY_DELAY_MS = 500;

/**
 * Sabotage scenario: an invisible full-viewport pointer trap. A cookie banner
 * gates the flow first, then after OVERLAY_DELAY_MS a transparent fixed
 * overlay appears above the page content and swallows every click, so the
 * Continue button never fires even though it looks clickable. The overlay can
 * only be dismissed via a small unlabeled chip pinned to its top-right corner;
 * blocked clicks increment a visible counter so the agent gets feedback that
 * its clicks are being intercepted. The cookie banner sits above the overlay
 * in z-order so it stays clickable throughout.
 */
export default function OverlayTrap() {
  const [cookiesAccepted, setCookiesAccepted] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [blockedClicks, setBlockedClicks] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      setOverlayVisible(true);
    }, OVERLAY_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  /**
   * Fires only when the overlay is gone and the banner is accepted; while the
   * overlay is up this handler is unreachable because the overlay covers it.
   */
  const handleContinue = () => {
    if (!cookiesAccepted) {
      return;
    }
    setDone(true);
  };

  if (done) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          You made it past the overlay
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Accept cookies, close whatever is blocking clicks, then press Continue.
      </p>
      <p data-testid="blocked-count" style={styles.blockedText}>
        Blocked clicks: {blockedClicks}
      </p>
      <button
        type="button"
        data-testid="continue-button"
        style={cookiesAccepted ? styles.button : styles.buttonDisabledLook}
        onClick={handleContinue}
      >
        Continue
      </button>
      {overlayVisible && !overlayDismissed ? (
        <div style={styles.overlay} onClick={() => setBlockedClicks((count) => count + 1)}>
          <button
            type="button"
            style={styles.overlayChip}
            onClick={(event) => {
              event.stopPropagation();
              setOverlayDismissed(true);
            }}
          >
            × close overlay
          </button>
        </div>
      ) : null}
      {!cookiesAccepted ? (
        <div style={styles.cookieBanner}>
          <span style={styles.cookieText}>We use cookies to run this benchmark.</span>
          <button
            type="button"
            data-testid="accept-cookies-button"
            style={styles.button}
            onClick={() => setCookiesAccepted(true)}
          >
            Accept cookies
          </button>
        </div>
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
  blockedText: {
    fontSize: 14,
    color: "#333",
    textAlign: "center",
    margin: 0,
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
  buttonDisabledLook: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
    opacity: 0.6,
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "transparent",
    zIndex: 20,
  },
  overlayChip: {
    position: "absolute",
    top: 12,
    right: 12,
    zIndex: 21,
    backgroundColor: "#fff",
    color: "#333",
    border: "1px solid #ccc",
    borderRadius: 999,
    padding: "4px 10px",
    fontSize: 13,
    cursor: "pointer",
  },
  cookieBanner: {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: "12px 16px",
    backgroundColor: "#f4f4f4",
    borderTop: "1px solid #e5e5e5",
  },
  cookieText: {
    fontSize: 14,
    color: "#333",
  },
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
