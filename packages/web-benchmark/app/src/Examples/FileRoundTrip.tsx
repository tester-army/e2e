"use client";

import { type CSSProperties, type ChangeEvent, useRef, useState } from "react";

const VOUCHER_CONTENT = "VOUCHER:WEB-5521";
const FILE_NAME = "voucher.txt";

export default function FileRoundTrip() {
  const [downloaded, setDownloaded] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Generates the voucher file in memory and triggers a browser download via
   * a temporary object-URL anchor, then revokes the URL to avoid leaks.
   */
  const handleDownload = () => {
    const blob = new Blob([VOUCHER_CONTENT], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = FILE_NAME;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setDownloaded(true);
  };

  /**
   * Reads the uploaded file's text and verifies it matches the issued voucher
   * exactly (trimmed). A mismatch is recoverable: the input resets so another
   * file can be chosen.
   */
  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setSelectedFileName(file.name);
    const content = await file.text();
    if (content.trim() === VOUCHER_CONTENT) {
      setError(null);
      setVerified(true);
    } else {
      setError("That is not the voucher we issued");
      if (uploadInputRef.current) {
        uploadInputRef.current.value = "";
      }
    }
  };

  if (verified) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Voucher verified
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Download the voucher file, then upload the same file back to verify it.
      </p>
      <button
        type="button"
        data-testid="download-button"
        style={styles.button}
        onClick={handleDownload}
      >
        Download voucher
      </button>
      {downloaded ? (
        <p data-testid="download-status" style={styles.statusText}>
          Voucher downloaded
        </p>
      ) : null}
      <input
        data-testid="upload-input"
        ref={uploadInputRef}
        style={styles.fileInput}
        type="file"
        accept=".txt"
        onChange={handleUpload}
      />
      <p style={styles.fileNameText}>
        {selectedFileName ? `Selected file: ${selectedFileName}` : "No file selected"}
      </p>
      {error ? (
        <p data-testid="error-message" style={styles.errorText}>
          {error}
        </p>
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
  statusText: {
    fontSize: 13,
    color: "#666",
    margin: 0,
  },
  fileInput: {
    border: "1px solid #ccc",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 16,
  },
  fileNameText: {
    fontSize: 13,
    color: "#666",
    margin: 0,
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
