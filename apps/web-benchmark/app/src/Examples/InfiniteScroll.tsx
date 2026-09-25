"use client";

import { type CSSProperties, type UIEvent, useRef, useState } from "react";

const PAGE_SIZE = 20;
const TARGET_INDEX = 137;
const LOAD_DELAY_MS = 400;
const TOTAL_ITEMS = 200;

type FeedItem = {
  index: number;
  title: string;
  subtitle: string;
};

/**
 * Builds one deterministic page of feed items; the target index is titled
 * "Golden Ticket" instead of its plain numbered title.
 */
const buildPage = (page: number): FeedItem[] => {
  const start = page * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, TOTAL_ITEMS);
  const items: FeedItem[] = [];
  for (let i = start; i < end; i += 1) {
    items.push({
      index: i,
      title: i === TARGET_INDEX ? "Golden Ticket" : `Item ${i + 1}`,
      subtitle: `Feed entry ${i + 1} of ${TOTAL_ITEMS}`,
    });
  }
  return items;
};

export default function InfiniteScroll() {
  const [items, setItems] = useState<FeedItem[]>(() => buildPage(0));
  const [loading, setLoading] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const pageRef = useRef(1);

  /**
   * Appends the next deterministic page after LOAD_DELAY_MS when the user
   * scrolls within 200px of the bottom and more pages remain.
   */
  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
    if (scrollTop + clientHeight < scrollHeight - 200) {
      return;
    }
    if (loading || pageRef.current * PAGE_SIZE >= TOTAL_ITEMS) {
      return;
    }
    setLoading(true);
    setTimeout(() => {
      setItems((previous) => [...previous, ...buildPage(pageRef.current)]);
      pageRef.current += 1;
      setLoading(false);
    }, LOAD_DELAY_MS);
  };

  return (
    <div style={styles.container}>
      <p style={styles.hint}>Scroll until you find the Golden Ticket, then claim it.</p>
      {claimed ? (
        <p data-testid="success-message" style={styles.successText}>
          Golden Ticket claimed
        </p>
      ) : null}
      <div data-testid="feed" style={styles.feed} onScroll={handleScroll}>
        {items.map((item) => (
          <div key={item.index} data-testid="feed-item" style={styles.row}>
            <div style={styles.rowText}>
              <span style={styles.rowTitle}>{item.title}</span>
              <span style={styles.rowSubtitle}>{item.subtitle}</span>
            </div>
            {item.index === TARGET_INDEX ? (
              <button
                type="button"
                data-testid="claim-button"
                style={styles.button}
                onClick={() => setClaimed(true)}
              >
                Claim
              </button>
            ) : null}
          </div>
        ))}
        {loading ? (
          <div data-testid="loading-more" style={styles.loadingRow}>
            Loading more…
          </div>
        ) : null}
      </div>
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
  feed: {
    height: 480,
    overflow: "auto",
    border: "1px solid #e5e5e5",
    borderRadius: 8,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "12px 16px",
    borderBottom: "1px solid #f0f0f0",
  },
  rowText: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: 600,
  },
  rowSubtitle: {
    fontSize: 13,
    color: "#666",
  },
  loadingRow: {
    padding: "16px",
    textAlign: "center",
    fontSize: 14,
    color: "#666",
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
  successText: {
    fontSize: 20,
    fontWeight: 600,
    color: "#0a0",
    textAlign: "center",
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
