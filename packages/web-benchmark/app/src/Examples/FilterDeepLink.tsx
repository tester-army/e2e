"use client";

import { type CSSProperties, useEffect, useMemo, useState } from "react";

const PRODUCTS = [
  "Trail Backpack",
  "Steel Water Bottle",
  "Merino Hiking Socks",
  "Camp Lantern",
  "Titanium Mug",
];

export default function FilterDeepLink() {
  const [query, setQuery] = useState("");

  // A shared link carries the filter, so opening ?q=mug must show the filtered view.
  useEffect(() => {
    const shared = new URLSearchParams(window.location.search).get("q");
    if (shared) {
      setQuery(shared);
    }
  }, []);

  /**
   * Mirrors the filter into the URL the way real dashboards do, so the only
   * way to verify the deep link is to read the query string from the page
   * address. A harness that strips query params from the reported URL makes
   * this task impossible to pass; a harness that reports them makes it
   * trivial.
   */
  const applyFilter = (value: string) => {
    setQuery(value);
    const url = new URL(window.location.href);
    if (value) {
      url.searchParams.set("q", value);
    } else {
      url.searchParams.delete("q");
    }
    window.history.replaceState({}, "", url);
  };

  const visible = useMemo(
    () => PRODUCTS.filter((name) => name.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Filter the list for mug, then verify the page URL carries the filter as ?q=mug so the view
        is shareable.
      </p>
      <input
        data-testid="filter-input"
        style={styles.input}
        placeholder="Filter products"
        value={query}
        onChange={(event) => applyFilter(event.target.value)}
      />
      <ul data-testid="product-list" style={styles.list}>
        {visible.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
      {visible.length === 0 ? <p data-testid="empty-state">No products match.</p> : null}
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
    fontSize: 15,
  },
  list: {
    margin: 0,
    paddingLeft: 20,
  },
} satisfies Record<string, CSSProperties>;
