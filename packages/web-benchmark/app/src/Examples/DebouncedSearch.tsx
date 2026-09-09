"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DEBOUNCE_MS = 500;
const SEARCH_MS = 700;
const TARGET = "Trail Mix 500 g";

const ITEMS = [
  "Trail Mix 250 g",
  "Trail Mix 500 g",
  "Trail Mix 750 g",
  "Trial Mix 500 g",
  "Nut Mix 500 g",
  "Trail Mix 500 mg",
  "Trail Max 500 g",
  "Fruit Mix 500 g",
  "Trail Mix 50 g",
  "Seed Mix 500 g",
];

const toKebab = (name: string) => name.toLowerCase().replace(/\s+/g, "-");

/**
 * Sabotage scenario: the results listbox is rendered through a portal onto
 * document.body, so it is detached from the combobox in the DOM tree - agents
 * that only search inside the input's ancestors never find the options. The
 * query is debounced and followed by a fake search delay, and the dataset is
 * full of near-identical decoys one character away from the target.
 */
export default function DebouncedSearch() {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [listboxPosition, setListboxPosition] = useState({ top: 0, left: 0, width: 0 });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setMounted(true);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (searchRef.current) clearTimeout(searchRef.current);
    };
  }, []);

  /**
   * Debounces the query, simulates a search round trip, then measures the
   * input rect so the portal listbox can be pinned directly under it.
   */
  const handleChange = (value: string) => {
    setQuery(value);
    setResults(null);
    setSearching(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (searchRef.current) clearTimeout(searchRef.current);
    if (!value.trim()) {
      return;
    }
    debounceRef.current = setTimeout(() => {
      setSearching(true);
      searchRef.current = setTimeout(() => {
        const matches = ITEMS.filter((item) =>
          item.toLowerCase().includes(value.trim().toLowerCase()),
        );
        const rect = inputRef.current?.getBoundingClientRect();
        if (rect) {
          setListboxPosition({ top: rect.bottom + 4, left: rect.left, width: rect.width });
        }
        setSearching(false);
        setResults(matches);
      }, SEARCH_MS);
    }, DEBOUNCE_MS);
  };

  const handleSelect = (item: string) => {
    if (item === TARGET) {
      setError(null);
      setResults(null);
      setDone(true);
      return;
    }
    setError("Wrong item, look closer");
  };

  if (done) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Added {TARGET} to the cart
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>Search for trail mix and pick exactly {TARGET}.</p>
      <input
        ref={inputRef}
        data-testid="search-input"
        style={styles.input}
        role="combobox"
        aria-expanded={results !== null}
        placeholder="Search snacks"
        value={query}
        onChange={(event) => handleChange(event.target.value)}
      />
      {searching ? (
        <p data-testid="searching" style={styles.searchingText}>
          Searching…
        </p>
      ) : null}
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
      ) : null}
      {mounted && results !== null
        ? createPortal(
            <ul
              role="listbox"
              style={{
                ...styles.listbox,
                top: listboxPosition.top,
                left: listboxPosition.left,
                width: listboxPosition.width,
              }}
            >
              {results.length === 0 ? (
                <li style={styles.emptyOption}>No matches</li>
              ) : (
                results.map((item) => (
                  <li
                    key={item}
                    role="option"
                    aria-selected={false}
                    data-testid={`option-${toKebab(item)}`}
                    style={styles.option}
                    onClick={() => handleSelect(item)}
                  >
                    {item}
                  </li>
                ))
              )}
            </ul>,
            document.body,
          )
        : null}
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
  searchingText: {
    fontSize: 14,
    color: "#333",
    textAlign: "center",
    margin: 0,
  },
  listbox: {
    position: "fixed",
    zIndex: 40,
    margin: 0,
    padding: 4,
    listStyle: "none",
    backgroundColor: "#fff",
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
  },
  option: {
    padding: "8px 10px",
    fontSize: 15,
    borderRadius: 6,
    cursor: "pointer",
  },
  emptyOption: {
    padding: "8px 10px",
    fontSize: 14,
    color: "#666",
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
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;
