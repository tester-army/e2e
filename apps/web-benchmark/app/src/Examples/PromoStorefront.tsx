"use client";

import { type CSSProperties, useEffect, useState } from "react";

const DEALS = [
  { id: "headphones", name: "Wireless Headphones", originalPrice: 80, salePrice: 40 },
  { id: "speaker", name: "Pocket Speaker", originalPrice: 50, salePrice: 35 },
];

// NO PLANTED BUG - this scenario is a false-positive trap. It piles up
// patterns the agent must NOT report: a sticky header over scrollable
// content, a cookie banner, a chat widget, correct strikethrough sale math,
// and a skeleton section that resolves after a fixed delay. The purchase
// flow works end to end and the run must pass with zero issues.
export default function PromoStorefront() {
  const [cookiesDismissed, setCookiesDismissed] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [reviewsLoaded, setReviewsLoaded] = useState(false);
  const [purchasedId, setPurchasedId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setReviewsLoaded(true), 1200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div style={styles.container}>
      <header style={styles.stickyHeader}>
        <strong>SoundShop</strong>
        <span style={styles.headerBadge}>Summer sale - up to 50% off</span>
      </header>
      <ul data-testid="deal-list" style={styles.list}>
        {DEALS.map((deal) => {
          const discountPercent = Math.round(
            ((deal.originalPrice - deal.salePrice) / deal.originalPrice) * 100,
          );
          return (
            <li key={deal.id} data-testid={`deal-${deal.id}`} style={styles.dealCard}>
              <div>
                <p style={styles.dealName}>{deal.name}</p>
                <p style={styles.dealPricing}>
                  <s style={styles.originalPrice}>${deal.originalPrice.toFixed(2)}</s>{" "}
                  <strong>${deal.salePrice.toFixed(2)}</strong>{" "}
                  <span style={styles.discountBadge}>{discountPercent}% OFF</span>
                </p>
              </div>
              {purchasedId === deal.id ? (
                <p data-testid="success-message" style={styles.purchasedText}>
                  Order confirmed
                </p>
              ) : (
                <button
                  type="button"
                  data-testid={`buy-${deal.id}`}
                  style={styles.buyButton}
                  onClick={() => setPurchasedId(deal.id)}
                >
                  Buy now
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <section data-testid="reviews-section" style={styles.reviewsSection}>
        {reviewsLoaded ? (
          <>
            <p style={styles.reviewText}>
              <strong>Jonas</strong> ★★★★★ Great bass and the battery lasts all week.
            </p>
            <p style={styles.reviewText}>
              <strong>Amelia</strong> ★★★★ Comfortable fit, pairing was instant.
            </p>
          </>
        ) : (
          <>
            <div style={styles.skeleton} />
            <div style={styles.skeleton} />
          </>
        )}
      </section>
      {!cookiesDismissed ? (
        <div data-testid="cookie-banner" style={styles.cookieBanner}>
          <span style={styles.cookieText}>We use cookies to improve your experience.</span>
          <button
            type="button"
            data-testid="accept-cookies"
            style={styles.cookieButton}
            onClick={() => setCookiesDismissed(true)}
          >
            Accept
          </button>
        </div>
      ) : null}
      <div style={styles.chatCorner}>
        {chatOpen ? (
          <div data-testid="chat-panel" style={styles.chatPanel}>
            <p style={styles.chatText}>Hi! How can we help?</p>
            <button
              type="button"
              data-testid="chat-close"
              style={styles.chatCloseButton}
              onClick={() => setChatOpen(false)}
            >
              Close
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-testid="chat-bubble"
            aria-label="Open support chat"
            style={styles.chatBubble}
            onClick={() => setChatOpen(true)}
          >
            💬
          </button>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: "24px 0 96px",
  },
  stickyHeader: {
    position: "sticky",
    top: 0,
    zIndex: 2,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#111",
    color: "#fff",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
  },
  headerBadge: {
    fontSize: 12,
    color: "#ffd400",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  dealCard: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: 16,
  },
  dealName: {
    fontSize: 15,
    fontWeight: 600,
    margin: "0 0 4px",
  },
  dealPricing: {
    fontSize: 14,
    margin: 0,
  },
  originalPrice: {
    color: "#999",
    fontSize: 13,
  },
  discountBadge: {
    backgroundColor: "#ffd400",
    borderRadius: 4,
    padding: "2px 6px",
    fontSize: 11,
    fontWeight: 700,
  },
  buyButton: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  purchasedText: {
    color: "#0a0",
    fontWeight: 600,
    fontSize: 14,
    margin: 0,
  },
  reviewsSection: {
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  reviewText: {
    fontSize: 14,
    margin: 0,
  },
  skeleton: {
    height: 16,
    borderRadius: 4,
    backgroundColor: "#eee",
  },
  cookieBanner: {
    position: "fixed",
    left: 16,
    right: 16,
    bottom: 16,
    zIndex: 3,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#fff",
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "12px 16px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
  },
  cookieText: {
    fontSize: 13,
  },
  cookieButton: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 14px",
    fontSize: 13,
    cursor: "pointer",
  },
  chatCorner: {
    position: "fixed",
    right: 16,
    bottom: 72,
    zIndex: 3,
  },
  chatBubble: {
    width: 44,
    height: 44,
    borderRadius: 22,
    border: "none",
    backgroundColor: "#111",
    fontSize: 18,
    cursor: "pointer",
  },
  chatPanel: {
    backgroundColor: "#fff",
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: 12,
    boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  chatText: {
    fontSize: 13,
    margin: 0,
  },
  chatCloseButton: {
    border: "1px solid #ccc",
    backgroundColor: "#fff",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 12,
    cursor: "pointer",
  },
} satisfies Record<string, CSSProperties>;
