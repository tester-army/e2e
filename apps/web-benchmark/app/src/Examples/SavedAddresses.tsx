"use client";

import { type CSSProperties, useState } from "react";

type Address = {
  id: string;
  label: string;
  line: string;
};

const INITIAL_ADDRESSES: Address[] = [
  { id: "home", label: "Home", line: "12 Rosewood Lane, Portland" },
  { id: "office", label: "Office", line: "400 Market Street, Portland" },
];

export default function SavedAddresses() {
  const [addresses, setAddresses] = useState<Address[]>(INITIAL_ADDRESSES);
  const [label, setLabel] = useState("");
  const [line, setLine] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  /** Appends a new address from the form fields and clears the form. */
  const addAddress = () => {
    if (!label.trim() || !line.trim()) return;
    setAddresses((current) => [
      ...current,
      { id: `custom-${current.length}`, label: label.trim(), line: line.trim() },
    ]);
    setLabel("");
    setLine("");
    setToast("Address saved");
  };

  /**
   * Handles the delete button.
   * PLANTED BUG (do not fix): the confirmation toast fires but the address is
   * never removed from the list, no matter how many times delete is clicked.
   */
  const deleteAddress = () => {
    setToast("Address deleted");
  };

  return (
    <div style={styles.container}>
      {toast ? (
        <p data-testid="toast" style={styles.toast}>
          {toast}
        </p>
      ) : null}
      <ul data-testid="address-list" style={styles.list}>
        {addresses.map((address) => (
          <li key={address.id} data-testid={`address-${address.id}`} style={styles.row}>
            <span style={styles.addressText}>
              <strong>{address.label}</strong> {address.line}
            </span>
            <button
              type="button"
              data-testid={`delete-${address.id}`}
              style={styles.deleteButton}
              onClick={deleteAddress}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <div style={styles.form}>
        <input
          data-testid="label-input"
          style={styles.input}
          placeholder="Label (e.g. Cabin)"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <input
          data-testid="line-input"
          style={styles.input}
          placeholder="Street address"
          value={line}
          onChange={(event) => setLine(event.target.value)}
        />
        <button
          type="button"
          data-testid="add-button"
          style={styles.addButton}
          onClick={addAddress}
        >
          Add address
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    padding: "24px 0",
  },
  toast: {
    backgroundColor: "#111",
    color: "#fff",
    borderRadius: 8,
    padding: "10px 14px",
    fontSize: 14,
    margin: 0,
    textAlign: "center",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    padding: "12px 4px",
    borderBottom: "1px solid #e5e5e5",
    fontSize: 14,
  },
  addressText: {
    display: "flex",
    gap: 8,
  },
  deleteButton: {
    border: "1px solid #c00",
    color: "#c00",
    backgroundColor: "#fff",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  input: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 15,
  },
  addButton: {
    backgroundColor: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
} satisfies Record<string, CSSProperties>;
