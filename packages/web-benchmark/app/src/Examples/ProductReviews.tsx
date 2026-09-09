"use client";

import type { CSSProperties } from "react";

// PLANTED BUG (do not fix): every review on this running-shoe page is clearly
// about a coffee grinder - wrong product's reviews are wired to the page.
const REVIEWS = [
  {
    id: "rev-1",
    author: "Marta",
    rating: 5,
    text: "Grinds beans perfectly evenly - my espresso has never tasted better.",
  },
  {
    id: "rev-2",
    author: "Deon",
    rating: 5,
    text: "Quiet enough to use before the family wakes up. The burrs feel very solid.",
  },
  {
    id: "rev-3",
    author: "Priya",
    rating: 4,
    text: "Hopper could be bigger, but the grind settings are precise. Great for pour over.",
  },
];

export default function ProductReviews() {
  return (
    <div style={styles.container}>
      <div style={styles.productCard}>
        <h2 style={styles.productName}>Peak Trail Running Shoes</h2>
        <p style={styles.productMeta}>$139.00 - Sizes 6 to 13 - Ships in 2 days</p>
        <p style={styles.productDescription}>
          Lightweight trail runners with a grippy outsole and a breathable knit upper. Built for
          long runs on rocky terrain.
        </p>
      </div>
      <section>
        <h3 style={styles.reviewsTitle}>
          Customer reviews <span style={styles.rating}>4.7 out of 5</span>
        </h3>
        <ul data-testid="review-list" style={styles.list}>
          {REVIEWS.map((review) => (
            <li key={review.id} data-testid={review.id} style={styles.reviewCard}>
              <p style={styles.reviewHeader}>
                <strong>{review.author}</strong> {"★".repeat(review.rating)}
              </p>
              <p style={styles.reviewText}>{review.text}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
    padding: "24px 0",
  },
  productCard: {
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: 16,
  },
  productName: {
    fontSize: 18,
    fontWeight: 700,
    margin: "0 0 4px",
  },
  productMeta: {
    fontSize: 13,
    color: "#666",
    margin: "0 0 8px",
  },
  productDescription: {
    fontSize: 14,
    color: "#333",
    margin: 0,
    lineHeight: 1.5,
  },
  reviewsTitle: {
    fontSize: 15,
    fontWeight: 600,
    margin: "0 0 10px",
  },
  rating: {
    fontWeight: 400,
    fontSize: 13,
    color: "#666",
    marginLeft: 8,
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  reviewCard: {
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: 12,
  },
  reviewHeader: {
    fontSize: 14,
    margin: "0 0 6px",
  },
  reviewText: {
    fontSize: 14,
    color: "#333",
    margin: 0,
    lineHeight: 1.5,
  },
} satisfies Record<string, CSSProperties>;
