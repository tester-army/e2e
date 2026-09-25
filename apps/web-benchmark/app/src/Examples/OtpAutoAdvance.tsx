"use client";

import {
  type CSSProperties,
  type ClipboardEvent,
  type KeyboardEvent,
  useRef,
  useState,
} from "react";

const OTP_CODE = "493027";
const OTP_LENGTH = 6;

export default function OtpAutoAdvance() {
  const [digits, setDigits] = useState<string[]>(() => Array(OTP_LENGTH).fill(""));
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const verifyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Schedules verification 300ms after the last box fills. A wrong code
   * clears every box and returns focus to box 0 so the flow is recoverable.
   */
  const scheduleVerify = (nextDigits: string[]) => {
    if (verifyTimeoutRef.current) {
      clearTimeout(verifyTimeoutRef.current);
    }
    verifyTimeoutRef.current = setTimeout(() => {
      if (nextDigits.join("") === OTP_CODE) {
        setError(null);
        setVerified(true);
      } else {
        setError("Incorrect code");
        setDigits(Array(OTP_LENGTH).fill(""));
        inputRefs.current[0]?.focus();
      }
    }, 300);
  };

  /**
   * Commits the next digit state and manages the pending verification: a full
   * code arms the verify timer, while any incomplete state cancels it so a
   * quick edit after filling all boxes never gets judged against stale input.
   */
  const applyDigits = (nextDigits: string[]) => {
    setDigits(nextDigits);
    if (nextDigits.every((digit) => digit !== "")) {
      scheduleVerify(nextDigits);
      return;
    }
    if (verifyTimeoutRef.current) {
      clearTimeout(verifyTimeoutRef.current);
      verifyTimeoutRef.current = null;
    }
  };

  /**
   * Handles a digit typed into box `index`: keeps only the last numeric
   * character, fills the box, and auto-advances focus to the next box so the
   * user can type the whole code without moving focus manually.
   */
  const handleChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    const nextDigits = [...digits];
    nextDigits[index] = digit;
    setError(null);
    applyDigits(nextDigits);
    if (digit && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  /**
   * Backspace on an already-empty box moves focus back to the previous box
   * and clears it, mirroring native OTP input behavior.
   */
  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && digits[index] === "" && index > 0) {
      event.preventDefault();
      const nextDigits = [...digits];
      nextDigits[index - 1] = "";
      applyDigits(nextDigits);
      inputRefs.current[index - 1]?.focus();
    }
  };

  /**
   * Distributes pasted digits across the boxes starting at the paste target,
   * then focuses the box after the last filled one.
   */
  const handlePaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "");
    if (!pasted) {
      return;
    }
    const nextDigits = [...digits];
    let cursor = index;
    for (const char of pasted) {
      if (cursor >= OTP_LENGTH) {
        break;
      }
      nextDigits[cursor] = char;
      cursor += 1;
    }
    setError(null);
    applyDigits(nextDigits);
    inputRefs.current[Math.min(cursor, OTP_LENGTH - 1)]?.focus();
  };

  if (verified) {
    return (
      <div style={styles.container}>
        <p data-testid="success-message" style={styles.successText}>
          Code verified
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <p style={styles.hint}>Enter code {OTP_CODE}.</p>
      <div style={styles.otpRow}>
        {digits.map((digit, index) => (
          <input
            key={index}
            data-testid={`otp-input-${index}`}
            ref={(node) => {
              inputRefs.current[index] = node;
            }}
            style={styles.otpInput}
            value={digit}
            maxLength={1}
            inputMode="numeric"
            autoComplete="one-time-code"
            onChange={(event) => handleChange(index, event.target.value)}
            onKeyDown={(event) => handleKeyDown(index, event)}
            onPaste={(event) => handlePaste(index, event)}
          />
        ))}
      </div>
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
  otpRow: {
    display: "flex",
    gap: 8,
    justifyContent: "center",
  },
  otpInput: {
    border: "1px solid #ccc",
    borderRadius: 8,
    width: 44,
    height: 52,
    fontSize: 20,
    textAlign: "center",
    padding: 0,
  },
  errorText: {
    color: "#c00",
    fontSize: 14,
    textAlign: "center",
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
